*** Settings ***
Resource    resources.robot


*** Test Cases ***
Goal: RCC can resolve the Fizzy Symphony robot environment
    Step    rcc ht vars -r robots/workitems/robot.yaml --json
    Must Have    RCC_ENVIRONMENT_HASH
    Must Have    ROBOT_ROOT
    Wont Have    robocorp==

Goal: Dev Doctor task passes in RCC
    Step    rcc run -r robots/workitems/robot.yaml --dev -t Doctor --silent
    Must Have    "safe_by_default": true
    Must Have    Doctor
    Must Have    status: PASS

Goal: FizzySymphony creates its own board and card in contract mode
    Remove Directory    robots/workitems/output/fizzy-symphony-contract    recursive=True
    Step    rcc run -r robots/workitems/robot.yaml --dev -t FizzySymphonyContractTest --silent
    Must Have    "status": "PASS"
    Must Have    "created_board": true
    Must Have    "created_card": true
    Must Have    contract-issue-1.md
    Must Have    status: PASS
    Must Exist    robots/workitems/output/fizzy-symphony-contract/fizzy-symphony-contract-test.json
    Must Exist    robots/workitems/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-1.md
    Must Exist    robots/workitems/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-2.md
    Must Exist    robots/workitems/output/fizzy-symphony-contract/workspace/contract-issues/contract-issue-3.md
    Must Exist    robots/workitems/output/fizzy-symphony-contract/workspace/FIZZY_SYMPHONY_CONTRACT_PLAN.md
