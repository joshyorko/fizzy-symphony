*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: WorkAI production smoke is manual and gated
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t WorkAIProductionSmoke --silent    expected=1
    Use Stderr
    Must Have    FullSmokeBlocked
    Must Have    disposable board id
