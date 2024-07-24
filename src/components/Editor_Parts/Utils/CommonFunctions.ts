import {TextNodeProcessor} from "../../Utils/Helpers";
import {TDaemonReturn} from "../../hooks/useEditorDaemon";

/**
 * Compiles all the text nodes within the specified container element.
 *
 * @param {HTMLElement} ContainerElement - The container element to search for text nodes.
 *
 * @returns {string} - The compiled text from all the found text nodes.
 */
export function CompileAllTextNode(ContainerElement: HTMLElement) {
    if (!ContainerElement) return null;
    let elementWalker = document.createTreeWalker(ContainerElement, NodeFilter.SHOW_TEXT);
    
    let node;
    let textContentResult = '';
    while (node = elementWalker.nextNode()) {
        let textActual = node.textContent;
        if (node.textContent) {
            if (node.textContent === '\u00A0')
                textActual = "";
            else
                textActual = node.textContent.replace(/\u00A0/g, ' ');
        }
        textContentResult += textActual;
    }
    return textContentResult;
}

export function UpdateComponentAndSync(daemonHandle: TDaemonReturn, TextNodeContent: string | null | undefined, ParentElement: HTMLElement | null) {
    if (!TextNodeContent || !ParentElement || !daemonHandle) return;
    const textNodeResult = TextNodeProcessor(TextNodeContent);
    if (!textNodeResult) return;
    
    let documentFragment = document.createDocumentFragment();
    textNodeResult?.forEach(item => documentFragment.appendChild(item));
    
    daemonHandle.AddToOperations({
        type: "REPLACE",
        targetNode: ParentElement,
        newNode: documentFragment //first result node only
    });
    return daemonHandle.SyncNow();
}