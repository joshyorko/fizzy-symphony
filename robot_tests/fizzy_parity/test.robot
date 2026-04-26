*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: FizzySymphony parity contract creates and discovers a golden ticket
    Remove Directory    ${CURDIR}/output/fizzy-symphony-parity-contract    recursive=True
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t FizzySymphonyParityContract --silent
    Must Have    "status": "PASS"
    Must Have    "golden_ticket_created": true
    Must Have    "discovered_golden_ticket": true
    Must Have    "work_card_number": 321
    Must Have    "card_number": 321
    Must Have    "move-to-done"
    Must Have    status: PASS
    Must Exist    ${CURDIR}/output/fizzy-symphony-parity-contract/fizzy-symphony-parity-contract.json
    Must Exist    ${CURDIR}/output/fizzy-symphony-parity-contract/workspace/prompt-proof.txt
