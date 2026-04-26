# Pocket Launch Control

Create a tiny static app that feels like a team of agents coordinating a launch
checklist. Keep it dependency-free so it can run by opening `index.html`.

## Card: Build the control room shell

Create the first usable screen for a static web app.

Requirements:

- Add `index.html` and `styles.css`.
- Show the app name `Pocket Launch Control`.
- Include areas for backlog, active agents, verification, and ship log.
- Keep the UI compact, readable, and useful on a laptop screen.

When finished, report the files changed and any validation you ran.

## Card: Add agent task data and rendering

Add the data and browser behavior that makes the board feel alive.

Requirements:

- Add `tasks.json` with at least five launch tasks across multiple agents.
- Add `app.js` that loads or embeds the task data and renders it into the page.
- Show task owner, state, and a short proof field.
- Make the page still work when opened directly from disk.

When finished, report the files changed and any validation you ran.

## Card: Add the operator handoff

Make the demo explain its final state through artifacts rather than prose on the
screen.

Requirements:

- Add `OPERATOR_HANDOFF.md` with the run summary, open risks, and next command.
- Add a tiny verification script or checklist that proves the app files exist.
- Update the UI only if needed to expose the ship log clearly.

When finished, report the files changed and any validation you ran.
