# Session Lens desktop

The dashboard in its own window (Electron). Not part of the root npm workspaces, so installing the CLI never downloads Electron.

```sh
cd session-lens && npm install && npm run build   # once
cd apps/desktop && npm install && npm start
```

`SESSION_LENS_PROJECTS=/path/a,/path/b npm start` points it at other transcript folders.
