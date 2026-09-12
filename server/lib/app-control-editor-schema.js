const tileId = { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" };
const path = { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\u0000-\\u001f\\u007f]+$" };
const revision = { type: "string", minLength: 1, maxLength: 128 };
const index = { type: "integer", minimum: 0, maximum: 2097152 };
const command = (description, properties = {}, required = []) => ({
  description, type: "object", properties: { tileId, ...properties }, required: ["tileId", ...required], additionalProperties: false,
});
export const EDITOR_APP_COMMANDS = {
  editor_get_state: command("Read an open editor's metadata and revision without exposing its buffer."),
  editor_read_buffer: command("Read a bounded page of the current unsaved editor buffer after the text file has finished loading.", { offset: index, length: { type: "integer", minimum: 1, maximum: 65536 } }),
  editor_edit_buffer: command("Apply a text edit to the current buffer only if its revision still matches. Offsets count UTF-16 code units; use the returned revision for the next edit.", { expectedRevision: revision, start: index, deleteCount: index, text: { type: "string", maxLength: 65536 } }, ["expectedRevision", "start", "deleteCount", "text"]),
  editor_save: command("Save the exact current editor revision to its selected device; preserve edits made while the save runs.", { expectedRevision: revision }, ["expectedRevision"]),
  editor_discard: command("Discard the specified buffer revision and reload the current file from disk.", { expectedRevision: revision }, ["expectedRevision"]),
  editor_close_file: command("Close the selected file only when its buffer is clean and idle."),
  editor_set_view: command("Configure the editor tree, Markdown preview or folder picker.", { tree: { type: "boolean" }, preview: { type: "boolean" }, folderPicker: { type: "boolean" } }),
  editor_copy_image: command("Copy the fully loaded image preview to the selected app device clipboard."),
  editor_list_directory: command("List a directory inside the editor root on the tile's device.", { path }),
  editor_move_file: command("Move or rename a file inside the editor root, preserving open editor buffers and updating all affected views.", { path, destination: path }, ["path", "destination"]),
  editor_delete_file: command("Delete a file or directory inside the editor root. Refuse affected unsaved editor buffers.", { path }, ["path"]),
  editor_refresh_tree: command("Reload the editor file tree."),
  editor_expand_directory: command("Expand or collapse a directory in the editor tree, including nested ancestors.", { path, expanded: { type: "boolean" } }, ["path", "expanded"]),
};
