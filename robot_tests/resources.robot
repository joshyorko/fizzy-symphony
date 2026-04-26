*** Settings ***
Library     OperatingSystem
Library     Process


*** Keywords ***
Step
    [Arguments]    ${command}    ${expected}=0
    ${result}=    Run Process    bash    -lc    ${command}
    Set Suite Variable    ${robot_stdout}    ${result.stdout}
    Set Suite Variable    ${robot_stderr}    ${result.stderr}
    Set Suite Variable    ${robot_output}    ${result.stdout}
    Log    <b>STDOUT</b><pre>${result.stdout}</pre>    html=yes
    Log    <b>STDERR</b><pre>${result.stderr}</pre>    html=yes
    Should Be Equal As Integers    ${expected}    ${result.rc}
    Should Not Contain    ${result.stdout}    status: FAIL

Use Stdout
    Set Suite Variable    ${robot_output}    ${robot_stdout}

Use Stderr
    Set Suite Variable    ${robot_output}    ${robot_stderr}

Must Have
    [Arguments]    ${content}
    Should Contain    ${robot_output}    ${content}

Wont Have
    [Arguments]    ${content}
    Should Not Contain    ${robot_output}    ${content}

Must Exist
    [Arguments]    ${path}
    Should Exist    ${path}
