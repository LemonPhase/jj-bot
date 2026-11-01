import { codeSegments } from "./taskModel";

/** An activity line with its command in mono: "Running `npm test`". */
export function ActivityText({ text }: { text: string }) {
  return (
    <>
      {codeSegments(text).map((segment, index) =>
        segment.code ? (
          // Segments never reorder, so their position is a stable key.
          <code key={index} className="task-code">
            {segment.text}
          </code>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}
