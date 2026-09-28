/**
 * What an Undo did. Anything placed, cleared or moved by somebody since the move is newer than it, and was left as
 * it is: the member is told how many, so a photograph that did not come back is not a mystery.
 */
export function undoneText(back: number, changed: number): string {
  const left = changed ? `${changed} had changed since, left as ${changed === 1 ? "it is" : "they are"}.` : "";
  if (!back) return left ? `Nothing was undone: ${left}` : "Nothing was undone.";
  const done = !changed ? (back === 1 ? "Undone. It is back where it was." : "Undone. They are back where they were.") : `Undone. ${back} ${back === 1 ? "is" : "are"} back where ${back === 1 ? "it was" : "they were"}.`;
  return left ? `${done} ${left}` : done;
}
