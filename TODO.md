# @craftled/pi-projects

## Done

- [x] Create `~/Sites/craftled/pi-projects`
- [x] Copy `/projects` extension to `index.ts`
- [x] Add `package.json` (`@craftled/pi-projects`), README, LICENSE, `.gitignore`

## Next

- [x] Smoke-test locally: `pi -e ./index.ts` and `pi -e .` both register `/projects` (RPC `get_commands`). Did not write global `settings.json`.
- [x] Stop loading the old global copy in `~/.pi/agent/extensions/my-extensions` (`projects.ts` removed; `index.ts` is a no-op)
- [x] `pi install` local path into global settings (`../../Sites/craftled/pi-projects`)
- [ ] `git init` and create `github.com/craftled/pi-projects`
- [ ] Optional gallery preview (`pi.image` or `pi.video` in package.json)
- [ ] Confirm npm login can publish to the `craftled` org (`@craftled/*`)
- [ ] `npm pack --dry-run`
- [ ] `npm publish --access public`
- [ ] Verify on npm and https://pi.dev/packages
