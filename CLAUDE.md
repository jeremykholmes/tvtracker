# Working on this repo

- When a change is done, open a pull request into `main` and merge it right away — no review step needed. The live site (a Cloudflare Worker) deploys automatically from `main` via Cloudflare Workers Builds; after merging, check that tvtracker.us has the change. Any new file that shouldn't be public goes in `.assetsignore`.
