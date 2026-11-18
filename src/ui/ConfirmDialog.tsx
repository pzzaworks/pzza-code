import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Modal } from "./Modal";
import { answerConfirmation, currentConfirmation, mountConfirmationHost, subscribeConfirmations, type ConfirmationRequest } from "../state/confirmations";
export { confirmAction, type ConfirmationOptions } from "../state/confirmations";

function Confirmation({ request }: { request: ConfirmationRequest }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const description = useId();
  return <Modal open onClose={() => answerConfirmation(request, false)} title={request.title} role="alertdialog" size="sm" describedBy={description} initialFocusRef={cancel}>
    <p className="confirmation-message" id={description}>{request.message}</p>
    <div className="modal-actions">
      <button type="button" className="btn" ref={cancel} onClick={() => answerConfirmation(request, false)}>Cancel</button>
      <button type="button" className={`btn ${request.danger ? "btn-danger" : "btn-accent"}`} onClick={() => answerConfirmation(request, true)}>{request.confirmLabel ?? "Confirm"}</button>
    </div>
  </Modal>;
}

export function ConfirmationHost() {
  const request = useSyncExternalStore(subscribeConfirmations, currentConfirmation, () => null);
  useLayoutEffect(mountConfirmationHost, []);
  return request ? <Confirmation key={request.id} request={request} /> : null;
}
