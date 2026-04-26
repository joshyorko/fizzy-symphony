*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: SQLite workitem flow passes in its own RCC project
    Remove Directory    ${CURDIR}/output    recursive=True
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t SmokeSQLiteWorkitemFlow --silent
    Must Have    "status": "PASS"
    Must Have    "safe_by_default": true
    Must Have    "mutated_fizzy": false
    Must Have    status: PASS
    Must Exist    ${CURDIR}/output/smoke-workitem-flow.json
