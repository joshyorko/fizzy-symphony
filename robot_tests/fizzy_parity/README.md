# Fizzy Parity RCC Suite

Runs the existing `FizzySymphonyParityContract` task from
`robots/workitems/tasks.py` inside this suite's own RCC environment root.

```bash
rcc run -r robot_tests/fizzy_parity/robot.yaml --dev -t Doctor --silent
rcc run -r robot_tests/fizzy_parity/robot.yaml --dev -t FizzySymphonyParityContract --silent
```

The task uses fake Fizzy subprocess responses and writes parity artifacts under
`robot_tests/fizzy_parity/output/`.
