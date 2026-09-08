export function toolResult(name, result) {
  if (name === "bridge_simulator_screenshot" && result?.encoding === "base64" && result.mimeType === "image/png" && typeof result.content === "string") {
    const bytes = Buffer.from(result.content, "base64");
    if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid simulator screenshot");
    return { content: [{ type: "image", data: result.content, mimeType: "image/png" }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
