# Registration regression tests

Run `pnpm test` for the normal suite. Run `pnpm test:registration-edges` as well before releasing changes to checkout, payment, sponsor allocations or files.

The second command requires a **disposable local PostgreSQL instance** on `127.0.0.1:54549`, with a local `qa_runner` role that can create databases. The suite verifies the address, port and role before creating an isolated database with a random name. Stripe, email, Sheets and App Storage are intercepted. No external payment or email credentials are needed.

The integration suite tests concurrent requests with separate database connections. It also opens ZIPs, checks manifests and file hashes, and interrupts a source stream during a download. Stop the disposable database after testing.

For a browser check, build the checkout frontend with `BASE_PATH=/` and `PORT=5000`. Run the edge command with `QA_EDGE_BROWSER=1` and the filter `-t "isolated browser checkout"` for a synthetic invoice at `http://127.0.0.1:4255/`. Use `QA_EDGE_SCANNER=1` and `-t "isolated scanner offline browser"` for the synthetic scanner at `http://127.0.0.1:4256/__qa-scanner-start`. Its test attendee’s badge contains `5CA1AB171234`.
