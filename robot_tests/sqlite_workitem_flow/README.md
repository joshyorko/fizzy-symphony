# SQLite Workitem Flow RCC Suite

Runs the deterministic SQLite workitem smoke from `robots/workitems/tasks.py`
inside its own RCC environment root.

```bash
rcc run -r robot_tests/sqlite_workitem_flow/robot.yaml --dev -t Doctor --silent
rcc run -r robot_tests/sqlite_workitem_flow/robot.yaml --dev -t SmokeSQLiteWorkitemFlow --silent
```

`SmokeSQLiteWorkitemFlow` is the existing deterministic SQLite task. It writes
artifacts under `robot_tests/sqlite_workitem_flow/output/` and does not mutate
Fizzy.
