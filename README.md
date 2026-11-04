# rps-portal

Sign-in page for the Rock Papers Scissors Employee Portal, served by GitHub Pages:
**https://brucerps.github.io/rps-portal/**

- Sign in, forgot password, and "set your password" for invite links from HR.
- Talks to the RPS Supabase project directly. The key in `index.html` is Supabase's *publishable* key, which is
  public by design; every table is protected by row-level security in the database.
- No data, passwords or secret keys live in this repository. Never add the Supabase secret / service-role key here.

Currently pointed at **rps-staging** (Mumbai).
