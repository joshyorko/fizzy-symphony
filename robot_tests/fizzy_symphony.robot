*** Settings ***
Resource    resources.robot


*** Test Cases ***
Goal: RCC can resolve the Fizzy Symphony robot environment
    Step    rcc ht vars -r robot_tests/sqlite_workitem_flow/robot.yaml --json
    Must Have    RCC_ENVIRONMENT_HASH
    Must Have    ROBOT_ROOT
    Wont Have    robocorp==

Goal: Dev Doctor task passes in RCC
    Step    rcc run -r robot_tests/sqlite_workitem_flow/robot.yaml --dev -t Doctor --silent
    Must Have    "safe_by_default": true
    Must Have    Doctor
    Must Have    status: PASS

Goal: SQLite workitem flow passes in its own RCC project
    Remove Directory    robot_tests/sqlite_workitem_flow/output    recursive=True
    Step    rcc run -r robot_tests/sqlite_workitem_flow/robot.yaml --dev -t SmokeSQLiteWorkitemFlow --silent
    Must Have    "status": "PASS"
    Must Have    "safe_by_default": true
    Must Have    "mutated_fizzy": false
    Must Have    status: PASS
    Must Exist    robot_tests/sqlite_workitem_flow/output/smoke-workitem-flow.json

Goal: FizzySymphony creates its own board and card in contract mode
    Remove Directory    robot_tests/fizzy_contract/output/fizzy-symphony-contract    recursive=True
    Step    rcc run -r robot_tests/fizzy_contract/robot.yaml --dev -t FizzySymphonyContractTest --silent
    Must Have    "status": "PASS"
    Must Have    "created_board": true
    Must Have    "created_card": true
    Must Have    contract-issue-1.md
    Must Have    status: PASS
    Must Exist    robot_tests/fizzy_contract/output/fizzy-symphony-contract/fizzy-symphony-contract-test.json
    Must Exist    robot_tests/fizzy_contract/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-1.md
    Must Exist    robot_tests/fizzy_contract/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-2.md
    Must Exist    robot_tests/fizzy_contract/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-3.md
    Must Exist    robot_tests/fizzy_contract/output/fizzy-symphony-contract/workspace/FIZZY_SYMPHONY_CONTRACT_PLAN.md

Goal: FizzySymphony parity contract creates and discovers a golden ticket
    Remove Directory    robot_tests/fizzy_parity/output/fizzy-symphony-parity-contract    recursive=True
    Step    rcc run -r robot_tests/fizzy_parity/robot.yaml --dev -t FizzySymphonyParityContract --silent
    Must Have    "status": "PASS"
    Must Have    "golden_ticket_created": true
    Must Have    "discovered_golden_ticket": true
    Must Have    "work_card_number": 321
    Must Have    "card_number": 321
    Must Have    "move-to-done"
    Must Have    status: PASS
    Must Exist    robot_tests/fizzy_parity/output/fizzy-symphony-parity-contract/fizzy-symphony-parity-contract.json
    Must Exist    robot_tests/fizzy_parity/output/fizzy-symphony-parity-contract/workspace/prompt-proof.txt
