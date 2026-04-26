Build a simple Ruby on Rails todo app in this workspace.

Requirements:

- If this workspace is empty and Rails is available, initialize a Rails app in place.
- Use SQLite for development/test storage.
- Add a `Todo` resource with:
  - `title:string`, required
  - `completed:boolean`, default false
  - optional `due_on:date`
- Make the root page show the todo list.
- Support creating, editing, completing/uncompleting, and deleting todos.
- Keep the UI plain and usable with standard Rails views.
- Add or update tests for the model and the main todo flow.
- Run the fastest relevant validation available, such as `bundle exec rails test`.

If a required local tool is missing, make the best useful Rails project change
you can, then report exactly what could not be run and what the operator should
install or retry.

When finished, reply with:

- files changed
- commands run
- validation result
- anything blocked
