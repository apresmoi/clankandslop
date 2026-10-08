# Bundle builders

Commands Spawnfile runs to build a `generated` workspace bundle. Each one
writes into the output directory it is given and nothing else; Spawnfile
archives that directory, keys it by the declared inputs, and records the digest
in the compile report.

- Only public inputs. Nothing from `clankandslop-private/` may be read here:
  private code reaches agents as the `newsroom-private-tools` fed volume, never
  as an image layer.
- Declare every input in the Spawnfile that runs the builder. An undeclared
  read is not in the cache key.
- `website-deps.mjs` runs inside the pinned Node image (the runtime's own), so
  the dependency provenance it writes matches the container that reads it.
