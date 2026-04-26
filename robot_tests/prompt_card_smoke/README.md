# Prompt Card Smoke RCC Suite

Manual, gated smoke for a single explicit prompt/card. It has its own RCC
environment root, but it is not part of automatic PR CI because it requires a
real workspace plus Codex SDK/app-server availability.

```bash
FIZZY_SYMPHONY_WORKSPACE="$PWD/tmp/prompt-card-workspace" \
FIZZY_SYMPHONY_PROMPT="Make a tiny safe change and report proof." \
FIZZY_SYMPHONY_BOARD_ID="board_disposable" \
FIZZY_SYMPHONY_CARD_NUMBER="42" \
rcc run -r robot_tests/prompt_card_smoke/robot.yaml --dev -t PromptCardSmoke --silent
```

Live Fizzy mutation remains opt-in through `FIZZY_SYMPHONY_LIVE_FIZZY=1` and
explicit board/card values.
