# Local security patch

Source: `@itsukichan/libsignal-node@1.0.1`.

The upstream package pins `protobufjs@6.8.8`, which is affected by multiple
security advisories and has no corrected release of the parent package. This
vendored copy preserves the upstream JavaScript and GPL-3.0 license unchanged;
only `package.json` raises `protobufjs` to `^7.6.5`.

Before replacing or updating this directory, run the backend test suite and the
engine Signal/protobuf smoke test documented in the repository deployment
checks.
