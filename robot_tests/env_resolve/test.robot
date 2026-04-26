*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: RCC environment resolves and runs a harmless task
    Remove Directory    ${CURDIR}/output    recursive=True
    Step    rcc ht vars -r ${CURDIR}/robot.yaml --json
    Must Have    RCC_ENVIRONMENT_HASH
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t EnvResolve --silent
    Must Have    "robot": "fizzy-symphony-workitems"
    Must Have    "safe_by_default": true
    Must Have    status: PASS
