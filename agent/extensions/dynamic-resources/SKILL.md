---
name: dynamic-resources
description: Dynamic resource management for pi — skills, prompts, and themes loaded at runtime. Use for managing custom resources that are generated or modified during a session.
---

# Dynamic Resources

## Overview

This skill provides dynamic resource registration for pi extensions and tools. Resources (skills, prompts, themes) registered through this system are available for the current session.

## Usage

Resources are registered programmatically via the extension API:

```ts
pi.on("resources_discover", () => {
    return {
        skillPaths: ["path/to/SKILL.md"],
        promptPaths: ["path/to/template.md"],
        themePaths: ["path/to/theme.json"],
    };
});
```

## Notes

- Dynamic resources are registered at session startup
- Supports hot-reload of themes
- Use for session-specific or generated content