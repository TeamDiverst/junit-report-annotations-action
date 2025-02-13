const core = require("@actions/core");
const github = require("@actions/github");
const glob = require("@actions/glob");
const parser = require("xml2js");
const fs = require("fs");
const path = require("path");

(async () => {
  try {
    const inputPath = core.getInput("path");
    const includeSummary = core.getInput("includeSummary");
    const numFailures = core.getInput("numFailures");
    const accessToken = core.getInput("access-token");
    const name = core.getInput("name");
    const testJobName = core.getInput("testJobName");
    const globber = await glob.create(inputPath, {
      followSymbolicLinks: false,
    });

    let testSummary = new TestSummary();
    testSummary.maxNumFailures = numFailures;
    testSummary.jobName = testJobName; // Include the passed in name in the summary text instead of generic "Junit Results"

    for await (const file of globber.globGenerator()) {
      const testsuites = await readTestSuites(file);
      for await (const testsuite of testsuites) {
        await testSummary.handleTestSuite(testsuite, file);
      }
    }

    const conclusion = testSummary.annotations.length === 0 ? "success" : "failure";

    // Don't include this summary annotation if 'includeSummary' input isn't true
    if (includeSummary === true) {
      const annotation_level = testSummary.isFailedOrErrored() ? "failure" : "notice";
      const annotation = {
        path: "test",
        start_line: 0,
        end_line: 0,
        start_column: 0,
        end_column: 0,
        annotation_level,
        message: testSummary.toFormattedMessage(),
      };

      testSummary.annotations = [annotation, ...testSummary.annotations];
    }

    if(testSummary.numTests > 0) {
      const pullRequest = github.context.payload.pull_request;
      const link = (pullRequest && pullRequest.html_url) || github.context.ref;
      const status = "completed";
      const head_sha = (pullRequest && pullRequest.head.sha) || github.context.sha;
      const annotations = testSummary.annotations;

      const createCheckRequest = {
        ...github.context.repo,
        name,
        head_sha,
        status,
        conclusion,
        output: {
          title: name,
          summary: testSummary.toFormattedMessage(),
          annotations,
        },
      };

      const octokit = new github.GitHub(accessToken);
      await octokit.checks.create(createCheckRequest);
    }
  } catch (error) {
    core.setFailed(JSON.stringify(error));
  }
})();

class TestSummary {

  maxNumFailures = -1;
  jobName = "";

  numTests = 0;
  numSkipped = 0;
  numFailed = 0;
  numErrored = 0;
  testDuration = 0;
  annotations = [];

  async handleTestSuite(testsuite, file) {
    if (testsuite.$) {
      this.testDuration += (Math.round(Number(testsuite.$.time) * 1000) / 1000) || 0; // Round duration to three decimal places
      this.numTests += Number(testsuite.$.tests) || 0;
      this.numErrored += Number(testsuite.$.errors) || 0;
      this.numFailed += Number(testsuite.$.failures) || 0;
      this.numSkipped += Number(testsuite.$.skipped) || 0;
    }

    if (testsuite.testcase) {
      for await (const testcase of testsuite.testcase) {
        await this.handleTestCase(testcase, file);
      }
    }
  }

  async handleTestCase(testcase, file) {
    console.log(testcase);

    if (!testcase.failure) {
      return;
    }

    console.log(testcase.failure);

    if (this.maxNumFailures !== -1 && this.annotations.length >= this.maxNumFailures) {
      return;
    }

    const {filePath, line} = await module.exports.findTestLocation(file, testcase);

    // TODO: Doesn't seem to properly retrieve the path for frontend tests (probably because they're in a subdirectory? Not sure)
    //       and the line number doesn't work for backend or frontend. Also need a stacktrace?
    this.annotations.push({
      path: filePath,
      start_line: line,
      end_line: line,
      // start_column: 0,
      // end_column: 0,
      annotation_level: "failure",
      title: `${this.jobName}: ${testcase.$.name}`,
      message: TestSummary.formatFailureMessage(testcase, filePath, line),
      raw_details: testcase.failure[0]._ || 'No details'
    });
  }

  static formatFailureMessage(testcase, filePath = null, line = null) {
    const failure = testcase.failure[0];

    let message = "";

    // TODO: Disable custom message structure for now since raw error output is more helpful
    // if (filePath) {
    //   message += `[${filePath}`;
    //   // TODO: Disable line number for now since it doesn't work properly
    //   // if (!isNaN(line))
    //   //   message += `:${line}`;
    //
    //   message += "] ";
    // }
    //
    // if (failure.$ && failure.$.message)
    //   message += `'${failure.$.message}' (${failure.$.type})`;
    //
    // if (failure._)
    //   message += `\n\n${failure._}`;

    // Seems to exist for the Rspec test output structure but not Jest
    if (failure.$ && failure.$.type)
      message += `${failure.$.type}: \n\n`;

    // Seems to be the Jest test output structure
    if (typeof failure === 'string')
      message += failure;
    // Seems to be the Rspec test output structure
    else if (failure._)
      message += failure._;


    return message;
  }

  isFailedOrErrored() {
    return this.numFailed > 0 || this.numErrored > 0;
  }

  toFormattedMessage() {
    return `${this.jobName} ran ${this.numTests} in ${this.testDuration} seconds: ${this.numErrored} Errored, ${this.numFailed} Failed, ${this.numSkipped} Skipped`;
  }

}

/**
 * Read JUnit XML report and return the list of all test suites in JSON format.
 *
 * XML children are mapped to JSON array of objects (ie b in <a><b></b></a> is mapped to
 * a.b[0]). XML attributes are mapped to a `$` JSON element (ie <a attr="value" /> is mapped to
 * a.$.attr). Tag content are mapped to a `_` JSON element (ie <a>content</a> is mapped to a._).
 *
 * The `testsuite` are directly the first accessible object in the returned array. Hence, the
 * expected schema is:
 *
 * ```
 * [
 *   {
 *     // A testsuite
 *     $: {
 *       name: 'value',
 *       // tests, skipped, failures, error, time, ...
 *     },
 *     testcase: [
 *       {
 *         // A testcase
 *         $: {
 *             name: 'value',
 *             // classname, time, ...
 *         },
 *         failure: [{
 *           $: {
 *             message: 'value',
 *             // type, ...
 *           },
 *           _: 'failure body'
 *         }]
 *       }
 *     ]
 *   }
 * ]
 * ```
 *
 * @param file filename of the XML to read from
 * @returns {Promise<[JSON]>} list of test suites in JSON
 */
async function readTestSuites(file) {
  const data = await fs.promises.readFile(file);
  const json = await parser.parseStringPromise(data);

  if (json.testsuites) {
    return json.testsuites.testsuite
  }
  return [json.testsuite];
}

/**
 * Find the file and the line of the test method that is specified in the given test case.
 *
 * The JUnit test report files are expected to be inside the project repository, next to the sources.
 * This is true for reports generated by Gradle, maven surefire and maven failsafe.
 *
 * The strategy to find the file of the failing test is to look for candidate files having the same
 * name that the failing class' canonical name (with '.' replaced by '/'). Then, given the above
 * expectation, the nearest candidate to the test report file is selected.
 *
 * @param testReportFile the file path of the JUnit test report
 * @param testcase the JSON test case in the JUnit report
 * @returns {Promise<{line: number, filePath: string}>} the line and the file of the failing test method.
 */
async function findTestLocation(testReportFile, testcase) {
  const klass = testcase.$.classname.replace(/$.*/g, "").replace(/\./g, "/");

  // Search in src directories because some files having the same name of the class may have been
  // generated in the build folder.
  const filePathGlob = `**/src/**/${klass}.*`;
  const filePaths = await glob.create(filePathGlob, {
    followSymbolicLinks: false,
  });
  let bestFilePath;
  let bestRelativePathLength = -1;
  for await (const candidateFile of filePaths.globGenerator()) {
    let candidateRelativeLength = path.relative(testReportFile, candidateFile)
      .length;

    if (!bestFilePath || candidateRelativeLength < bestRelativePathLength) {
      bestFilePath = candidateFile;
      bestRelativePathLength = candidateRelativeLength;
    }
  }
  let line = 0;
  if (bestFilePath !== undefined) {
    const file = await fs.promises.readFile(bestFilePath, {
      encoding: "utf-8",
    });
    //TODO: make this better won't deal with methods with arguments etc
    const lines = file.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(testcase.$.name) >= 0) {
        line = i + 1; // +1 because the first line is 1 not 0
        break;
      }
    }
  } else {
    //fall back so see something
    bestFilePath = `${klass}`;
  }
  return { filePath: bestFilePath, line };
}

module.exports.findTestLocation = findTestLocation;
module.exports.readTestSuites = readTestSuites;
module.exports.TestSummary = TestSummary;
