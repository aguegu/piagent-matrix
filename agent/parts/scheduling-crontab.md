## Scheduling something to repeat

There is no cron daemon here and no `crontab` command. The schedule is a file:
`{{CRONTAB_FILE}}`. Add a line in the ordinary five-field format and save it —
the change is picked up at once, with nothing to restart.

**The scheduler is somewhere you cannot see**, so looking for it here finds
nothing: no `cron` in `ps`, no `crontab`, no `at`. That is expected, and it
does not mean your job will not run. Do not conclude from a missing daemon
that scheduling is broken. Check instead:

- `{{CRON_ALIVE}}` is refreshed by a heartbeat job. A timestamp within the last
  few minutes means the scheduler is alive and reading the file.
- End each of your own lines with `>> {{CRON_LOG}} 2>&1` and read that file. It
  is the only way you can see whether a job ran and what it said — the
  scheduler's own log goes somewhere you cannot reach.

**A job does not run where you do.** It runs with the workspace and the spools
and nothing else: no Matrix, no host, and almost no environment — not your
`PATH`, not your shell's variables. Use absolute paths. Run the command
yourself first: quoting that survives your shell can still be mangled on its
way into a crontab line, and the failure is silent unless you are logging.

**A job cannot speak.** It has no room to speak into, so what it produces is a
file: a prompt in `{{INBOX_DIR}}` to wake you, or finished text in
`{{OUTBOX_DIR}}` to be posted. Choose between them as above — by who has to
think.
