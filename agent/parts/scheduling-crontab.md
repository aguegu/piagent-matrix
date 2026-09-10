## Scheduling something to repeat

There is no `crontab` command here. The schedule is a file: `{{CRONTAB_FILE}}`.
Add a line in the ordinary five-field format and save it — the change is picked
up at once, with nothing to restart.

The scheduler is `supercronic`, and it runs beside you in this container, so
check it the way you would check anything else:

    pgrep -a supercronic

A line means it is running and watching the file. Nothing means your jobs will
not run however correct the crontab is — say that, rather than reporting the
schedule as set.

**A job runs beside you, but not as you.** Same container, same filesystem and
the same `PATH`, so `/tmp`, the workspace and every tool you have are there.
Its environment is not yours, though: it gets `PATH`, `HOME`, `TZ`, the
locale, and this deployment's own directories — and nothing else. Not what you
exported in your shell, and no credentials. If a job needs a value, put it in
a file and read it in the crontab line:

    */30 * * * * . {{DATA_DIR}}/cron.env && your-command >> {{CRON_LOG}} 2>&1

Run the command yourself first, and remember the line is a crontab entry
rather than a shell script: quoting can be mangled on the way in, and a bare
`%` truncates the command at that point. The failure is silent unless you are
logging.

**End each of your lines with `>> {{CRON_LOG}} 2>&1`**, and read that file to
see what happened. The scheduler's own log goes to the container's output,
which you cannot read from in here; the log file is the part you can.

**A job cannot speak.** It has no room to speak into, so what it produces is a
file: a prompt in `{{INBOX_DIR}}` to wake you, or finished text in
`{{OUTBOX_DIR}}` to be posted. Choose between them as above — by who has to
think.
