# Security

Invintel is early (0.x) software. It has no production customers yet, and it makes no compliance or certification claims.

## Reporting a problem

Please report security problems **privately**, not as a public issue.

- Use GitHub's private reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**.
- Include what you found, how to reproduce it, and which version or commit you used. Please don't include other people's real data.

We will read every report and answer as soon as we can. This is a small team: there is no service-level promise and no bug bounty yet. We will tell you what we decide and credit you if you'd like.

## What to expect from us

- We fix real problems in the code on `main` and say so in the release notes or commit message.
- Please give us a reasonable time to fix a problem before you publish details.
- Please test only against your own installation, never against anyone else's, and don't access, change or delete data that isn't yours.

## Supported versions

Only the latest commit on `main`. There are no released, supported versions yet.

## Good to know

- The README's "known limits" sections list what is not done, for example the sign-in and rate-limit limits, webhook-secret handling and the audit log's limits.
- The demo login in `apps/api/src/seed-demo.ts` is published here and is for local demos only.
