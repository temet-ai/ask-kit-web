# ask-kit-web

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
read web pages and documentation sites. A cheap model fetches the page outside your agent's
context, reads the part that matters and answers with the page's address and the heading the
answer sits under. Your agent gets three lines instead of a 90,000-character page.

It does the job people give a web-fetch subagent or a "look it up in the docs" skill:

- What does https://nodejs.org/api/sqlite.html say about opening a database read-only?
- In the Claude Code docs, what does exit code 2 from a PreToolUse hook do?
- Which page of this site covers rate limits?
- What changed in the last release, from its release notes page?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later. The kit has no
dependencies. PDFs are read when `pdftotext` (poppler) is installed.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-web
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-web        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-web --yes  # installs and enables it
```

Restart your agents so `ask` lists `web`. Settings: `WORKDIR` (where a saved `.html` or `.md`
file is looked for; the folder your agent runs in) and `WEB_ALLOW_PRIVATE` (off; see below).

## What it reads

- Any `http` or `https` address, with GET, following redirects, with a 20-second timeout and a
  5 MB cap. No cookies, no login, no JavaScript. A page drawn by JavaScript has no text to read,
  and the kit says so.
- HTML is converted to Markdown: headings, paragraphs, lists, code blocks with their language,
  tables, links and emphasis. Navigation, header, footer, sidebars, forms, scripts, styles and
  hidden elements are dropped, and `<main>` or `<article>` is used when the page has one.
- A site's pages come from its `llms.txt`, or its `sitemap.xml` when it has none.
- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are honoured (Node's own `fetch` ignores them), so
  it works behind a company proxy.
- Pages are kept for 15 minutes under ask-kit's state folder (`web/cache/`).

It has no search engine: it needs an address or a site.

## What it can change

Nothing. It sends GET requests and writes its page cache.

What a page says is text nobody vouched for, and the model reading it could be told by the page
to fetch something else. So the kit refuses addresses on this machine and on private networks
(`localhost`, `10.x`, `192.168.x`, `169.254.169.254` and the like): otherwise a page could make
it read an internal address and put what it found into another request. Set
`WEB_ALLOW_PRIVATE=1` to turn that off on a machine where you want it to read internal sites.
Behind a proxy the proxy resolves names, so only the name and literal addresses can be checked.
Query values named like a token, key or signature are not echoed back.

## How well it works

`bench/questions.json` holds seven checks that run with no model against a saved page,
`bench/fixture/handbook.html`. `ask-kit kit test web` on 2026-11-20, run from the kit's folder:
7/7, all answered with no model. The site and docs scripts need the network and are not in the
bench; they were run by hand against nodejs.org and code.claude.com through a proxy.

The bench has no scored investigator-model run. `node test/find.mjs` checks single-page and
batch searches offline, including a failed page and the batch limit.

## What is in it

`http.mjs` is the GET client (redirects, timeout, size cap, proxy tunnel, the private-address
check), `html.mjs` the HTML to Markdown converter, and `web.mjs` the `web` global over them. Its
scripts are `read` (a page's outline and start, or one section), `find` (the passages that hold
some words; `urls:[...]` compares up to eight named pages in one call and reports failed pages),
`docs` (a documentation site and some words: the best pages and their passages),
`site` (the pages a site lists, ranked by words), `links` and `outline`.
[RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.

MIT licence.
