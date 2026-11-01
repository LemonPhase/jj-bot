// @vitest-environment jsdom
import "../../test/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input, Select, Textarea } from "./Field";

const describedByText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);

describe("Field components", () => {
  it("label their control and describe it with the hint and error", () => {
    render(
      <Input
        label="Image"
        hint="A Docker image reference."
        error="PROFILE_UNSUPPORTED: docker is not available."
      />,
    );
    const input = screen.getByLabelText("Image");
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedByText(input)).toEqual([
      "A Docker image reference.",
      "PROFILE_UNSUPPORTED: docker is not available.",
    ]);
  });

  it("merges a caller's aria-describedby with its own", () => {
    render(
      <>
        <p id="outside">Applies to every bot.</p>
        <Textarea
          label="Instructions"
          hint="Plain text."
          aria-describedby="outside"
        />
      </>,
    );
    const textarea = screen.getByLabelText("Instructions");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(describedByText(textarea)).toEqual([
      "Applies to every bot.",
      "Plain text.",
    ]);
    expect(textarea.hasAttribute("aria-invalid")).toBe(false);
  });

  it("omits aria-describedby when there is nothing to describe", () => {
    render(<Input label="Name" />);
    expect(screen.getByLabelText("Name").hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  it("keeps a hidden label for assistive technology", () => {
    render(<Input label="Message Juno" hideLabel />);
    expect(screen.getByLabelText("Message Juno").tagName).toBe("INPUT");
  });

  it("types Select changes by option value", () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Colour"
        value="coral"
        onChange={onChange}
        options={[
          { value: "coral", label: "Coral" },
          { value: "teal", label: "Teal" },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Colour"), {
      target: { value: "teal" },
    });
    expect(onChange).toHaveBeenCalledWith("teal");
  });
});
