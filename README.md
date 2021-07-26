# junit-report-annotations-action
Create an annotation of the build information and also list first n failed tests as seporate annotations

Note: Forked from https://github.com/ashley-taylor/junit-report-annotations-action in order to adjust functionality for our own use.

## Example
```
    - uses: TeamDiverst/junit-report-annotations-action@master
      if: always()
      with:
        access-token: ${{ secrets.GITHUB_TOKEN }}
``` 
   
A demonstration is available here
https://github.com/ashley-taylor/junit-report-annotations-action-example

On a succesful run will get a summary like

![Pass](/../images/pass.png?raw=true "Pass")

On a failed run will get a image like this

![Fail](/../images/fail.png?raw=true "Fail")
