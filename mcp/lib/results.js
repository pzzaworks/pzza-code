export function toolResult(name, result) {
  if (["git_protect", "git_commit", "git_create_pull_request"].includes(name) && result?.approved === false) {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
