*** Settings ***
Resource    ../resources.robot


*** Test Cases ***
Goal: Prompt card smoke is manual and gated
    Step    rcc run -r ${CURDIR}/robot.yaml --dev -t PromptCardSmoke --silent    expected=1
    Use Stderr
    Must Have    FullSmokeBlocked
    Must Have    FIZZY_SYMPHONY_PROMPT
