# Task attachments — UI brief

Screenshots and files can be added to a task when it is created and when it is edited.

## Create dialog (New task)

- **Brief field** becomes a container with two parts: a thumbnail strip on top, the text editor below.
- **Paste (⌘V) of an image** does not insert the image inline. It adds the image to the task's attachments, shown as a 56×56 rounded thumbnail at the top of the brief.
- Each thumbnail has a small ✕ badge on its top-right corner to remove it.
- **Instructions live in the editor's placeholder**, not in a label: "What's the context? Paste screenshots (⌘V) or drop files in here." The Brief label stays as-is.
- **Attach files button** sits directly under the brief — dashed outline, paperclip icon, `Attach files`. No section label.
- **Non-image files** appear as chips next to that button: file icon, name, size, ✕ to remove.
- **Drag and drop** onto the brief or the attach row adds files. While dragging over either, the target shows a dashed primary-colour border and a tinted background.
- Attachments are saved with the task on Create.

## Task modal

- Same behaviour on the brief in both layouts (brief pane and plain brief column), in view and edit mode:
  - Image attachments render as a thumbnail strip above the brief text; edit mode shows the ✕ remove badge, view mode does not.
  - `Attach files` button plus non-image file chips sit under the brief.
  - Paste and drop work while editing the brief; drop also works on the attach row.
- Changes persist to the task immediately (no separate save step).
- The former "Attachments" section in the details column is removed.

## Notes

- Images are held as data URLs; thumbnails are set on the element rather than through a style string.
- File sizes are formatted B / KB / MB.
