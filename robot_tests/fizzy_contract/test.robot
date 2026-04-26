*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: FizzySymphony creates its own board and card in contract mode
    Remove Directory    ${CURDIR}/output/fizzy-symphony-contract    recursive=True
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t FizzySymphonyContractTest --silent
    Must Have    "status": "PASS"
    Must Have    "created_board": true
    Must Have    "created_card": true
    Must Have    contract-issue-1.md
    Must Have    status: PASS
    Must Exist    ${CURDIR}/output/fizzy-symphony-contract/fizzy-symphony-contract-test.json
    Must Exist    ${CURDIR}/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-1.md
    Must Exist    ${CURDIR}/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-2.md
    Must Exist    ${CURDIR}/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-3.md
    Must Exist    ${CURDIR}/output/fizzy-symphony-contract/workspace/FIZZY_SYMPHONY_CONTRACT_PLAN.md
