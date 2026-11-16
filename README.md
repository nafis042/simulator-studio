# Simulator Studio

A [Paseo](https://paseo.sh) plugin: a 60 FPS iOS simulator view with live touch, screenshot
annotation and screen recording that go straight to the chat. See [OVERVIEW.md](OVERVIEW.md) for
what it does, what it needs and where data goes.

It is a fork of the [Devices](https://github.com/ZedObaia/paseo-plugins/tree/main/plugins/devices)
plugin by Zeyad Obaia (MIT) and keeps all of its features.

## Install

Needs Paseo 0.16.0-beta.2 or newer. Turn the Devices plugin off first if you have it.

```bash
paseo plugin add git:nafis042/simulator-studio
```

## Develop

```bash
npm ci
npm run typecheck
npm test
npx prettier@3.6.2 --check .
paseo plugin install "$PWD" --id simulator-studio
```

After an edit, `paseo plugin reload simulator-studio`.

## License

MIT. See [LICENSE](LICENSE).
