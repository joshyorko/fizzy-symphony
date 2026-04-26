# Env Resolve RCC Suite

Runs a minimal RCC task in this suite's own environment root. The reusable
GitHub workflow already runs `rcc ht vars` before this task, so this suite proves
both environment resolution and a harmless Robocorp task entrypoint.

```bash
rcc ht vars -r robot_tests/env_resolve/robot.yaml --json
rcc run -r robot_tests/env_resolve/robot.yaml --dev -t EnvResolve --silent
```

`EnvResolve` delegates to the existing `Doctor` task and writes only local
artifacts under `robot_tests/env_resolve/output/`.
