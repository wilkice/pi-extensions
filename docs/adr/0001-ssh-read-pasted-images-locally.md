# SSH mode reads pasted clipboard images locally

When you paste an image, pi writes it to the local `os.tmpdir()` as `pi-clipboard-<uuid>.<ext>` and inserts that path into the prompt. The model then calls `read` on it. In SSH mode every `read` went to the remote, where the file doesn't exist, so pasted images were unreadable. We decided that `read`, and only `read`, treats paths matching exactly that pattern (local tmpdir plus pi's clipboard filename) as local. `write`, `edit` and `bash` still go to the remote even for these paths, because the image is only for the model to look at and the remote never needs the file.

## Considered Options

- **Use the `input` hook to attach the image.** Replace pasted paths in the prompt with inline `images`, so the model sees the image without a tool call. Rejected: it's more code, its ordering relative to other `input` handlers (such as prompt polishing) is unclear, it departs from how pi behaves without SSH, and it doesn't help when a later turn or a resumed session mentions the path again.
- **Copy the image to the remote.** Rejected: the model only needs to see the image, so copying adds a round trip and leaves files behind on the remote.
- **Treat any path that exists locally as local**, which would also cover files copied in Finder. Rejected for now: once those paths are plain text in the prompt, a path like `/Users/x/a.png` can't be reliably told apart from a remote path. Only pi's own clipboard filename pattern is unambiguous.
