# Fizzy Contract RCC Suite

Runs the existing `FizzySymphonyContractTest` task from
`robots/workitems/tasks.py` inside this suite's own RCC environment root.

```bash
rcc run -r robot_tests/fizzy_contract/robot.yaml --dev -t Doctor --silent
rcc run -r robot_tests/fizzy_contract/robot.yaml --dev -t FizzySymphonyContractTest --silent
```

The task uses fake Fizzy subprocess responses and writes contract artifacts under
`robot_tests/fizzy_contract/output/`.
