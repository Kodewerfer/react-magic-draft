/**
 *  This hook handles the backend heavy lifting
 *
 *  At its core, it monitors the changes made in the first ref(the watched ref), rolls them back, and performs the same operation on the second ref(the mirrored ref).
 *  The reason for this convoluted logic is that, for the best UX, I made the main editing area as an editable HTML element that handles rendering of MD as well as user-editing.
 *  it allowed editing and rendering on the fly, but it also means that the virtual DOM and the actual DOM are now out of sync.
 *  If I've simply turned the actual DOM back to React compos again, React will crash because it may need to remove elements that are no longer there, etc.
 *  So, the original DOM needs to be kept as-is; the changes will be made on the other DOM ref instead, which will later be turned to React components so that React can do proper diffing and DOM manipulation.
 */


import {useLayoutEffect, useState} from "react";
import _ from 'lodash';

// Hook's persistent variables
type TDaemonState = {
    Observer: MutationObserver, //Mutation Observer instance
    MutationQueue: MutationRecord[] // All records will be pushed to here
}

//Type of actions to perform on the mirror document
enum TOperationType {
    TEXT = "TEXT",
    ADD = "ADD",
    REMOVE = "REMOVE"
}

// Instructions for DOM manipulations on the mirror document
type TOperationLog = {
    type: TOperationType,
    node: string | Node,
    nodeText?: string | null,
    parentNode?: string | null,
    siblingNode?: string | null
}

export default function useEditorHTMLDaemon(
    WatchElementRef: { current: HTMLElement | undefined | null },
    MirrorDocumentRef: { current: Document | undefined | null },
    FinalizeChanges: Function,
    EditableElement = true
) {

    // Persistent Variables
    // Easier to set up type and to init using state, but really acts as a ref.
    const DaemonState: TDaemonState = useState(() => {

        const state: TDaemonState = {
            Observer: null as any,
            MutationQueue: []
        }

        if (typeof MutationObserver) {
            state.Observer = new MutationObserver((mutationList: MutationRecord[]) => {
                state.MutationQueue.push(...mutationList);
            });
        }

        return state;
    })[0];

    const toggleObserve = (bObserver: boolean) => {

        if (!bObserver) {
            return DaemonState.Observer.disconnect();
        }

        if (!WatchElementRef.current) {
            return;
        }

        return DaemonState.Observer.observe(WatchElementRef.current, {
            childList: true,
            subtree: true,
            characterData: true,
            characterDataOldValue: true,

        });
    };

    // Flush all changes in the MutationQueue
    const FlushQueue = () => {

        // OB's callback is asynchronous
        // make sure no records are left behind
        DaemonState.MutationQueue.push(...DaemonState.Observer.takeRecords());

        if (!DaemonState.MutationQueue.length) return;

        toggleObserve(false);

        // Rollback Changes
        // TODO: there is an unfortunate "flash" between rolling back and parent re-rendering.
        let mutation: MutationRecord | void;
        let OperationLogs: TOperationLog[] = []
        while ((mutation = DaemonState.MutationQueue.pop())) {

            // Text Changed
            if (mutation.oldValue !== null && mutation.type === "characterData") {

                // rollback
                // mutation.target.textContent = mutation.oldValue;

                const Operation: TOperationLog = {
                    type: TOperationType.TEXT,
                    node: getXPathFromNode(mutation.target),
                    nodeText: mutation.target.textContent
                }

                const latestOperationLog = OperationLogs[OperationLogs.length - 1];

                if (JSON.stringify(latestOperationLog) !== JSON.stringify(Operation))
                    OperationLogs.push(Operation)
            }

            // Nodes removed
            for (let i = mutation.removedNodes.length - 1; i >= 0; i--) {

                // rollback
                mutation.target.insertBefore(
                    mutation.removedNodes[i],
                    mutation.nextSibling,
                );

                OperationLogs.push({
                    type: TOperationType.REMOVE,
                    node: getXPathFromNode(mutation.removedNodes[i]),
                    parentNode: getXPathFromNode(mutation.target)
                })
            }

            // Nodes added
            for (let i = mutation.addedNodes.length - 1; i >= 0; i--) {

                // rollback
                if (mutation.addedNodes[i].parentNode)
                    mutation.target.removeChild(mutation.addedNodes[i]);

                OperationLogs.push({
                    type: TOperationType.ADD,
                    node: mutation.addedNodes[i].cloneNode(true), //MUST be a deep clone, otherwise when breaking a new line, the text node content of a sub node will be lost.
                    parentNode: getXPathFromNode(mutation.target),
                    siblingNode: mutation.nextSibling ? getXPathFromNode(mutation.nextSibling) : null
                })
            }
        }

        SyncToMirror(OperationLogs);

        FinalizeChanges();

        // Start observing again.
        // TODO: this will not be needed once the changes are reported to the parent and therefore re-rendered
        return toggleObserve(true);
    }

    // Helper to get the precise location in the original DOM tree
    function getXPathFromNode(node: Node): string {

        if (!WatchElementRef.current) return '';
        let parent = node.parentNode;

        // XPath upper limit: any element with an ID
        if ((node as HTMLElement).id && (node as HTMLElement).id !== '') {
            return '//*[@id="' + (node as HTMLElement).id + '"]';
        }

        // XPath upper limit: The watched element.
        if ((node as HTMLElement).className === WatchElementRef.current.className && (node as HTMLElement).tagName === WatchElementRef.current.tagName) {
            return '//body';
        }

        // text nodes
        if (node.nodeType === Node.TEXT_NODE) {
            // For text nodes, count previous sibling text nodes for accurate XPath generation
            let textNodeIndex: number = 1;
            let sibling = node.previousSibling;

            // Counting preceding sibling Text nodes
            while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                    textNodeIndex++;
                }
                sibling = sibling.previousSibling;
            }

            if (parent) {
                return getXPathFromNode(parent) + '/text()' + `[${textNodeIndex}]`;
            } else {
                return 'text()' + `[${textNodeIndex}]`;
            }
        }

        if (!parent) return ''; // If no parent found, very unlikely scenario and possibly pointing at the HTML node

        // For Non-text nodes
        let nodeCount: number = 0;
        for (let i = 0; i < parent.childNodes.length; i++) {
            let sibling = parent.childNodes[i];

            if (sibling === node) {
                // Recurse on the parent node, then append this node's details to form an XPath string
                return getXPathFromNode(parent) + '/' + node.nodeName.toLowerCase() + '[' + (nodeCount + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.nodeName === node.nodeName) {
                nodeCount++;
            }
        }

        return '';
    }

    // Sync to the mirror document, middleman function
    const SyncToMirror = (Operations: TOperationLog[]) => {

        if (!Operations.length) return;

        let operation: TOperationLog | void;
        while ((operation = Operations.pop())) {
            const {type, node, nodeText, parentNode, siblingNode} = operation;
            console.log(operation);
            if (type === TOperationType.TEXT) {
                UpdateMirrorDocument.Text((node as string), nodeText!);
            }
            if (type === TOperationType.REMOVE) {
                UpdateMirrorDocument.Remove(parentNode!, (node as string));
            }
            if (type === TOperationType.ADD) {
                UpdateMirrorDocument.Add(parentNode!, (node as Node), siblingNode!)
            }

        }

    }

    // TODO: performance
    const UpdateMirrorDocument = {
        'Text': (XPath: string, Text: string | null) => {

            if (!XPath) {
                console.error("UpdateMirrorDocument.Text: Invalid Parameter");
                return;
            }

            const NodeResult = getNodeFromXPath(MirrorDocumentRef.current!, XPath);
            if (!NodeResult) return;

            if (!Text) Text = "";

            NodeResult.textContent = Text;
        },
        'Remove': (XPathParent: string, XPathSelf: string) => {

            if (!XPathParent || !XPathSelf) {
                console.error("UpdateMirrorDocument.Remove: Invalid Parameter");
                return;
            }

            const parentNode = getNodeFromXPath(MirrorDocumentRef.current!, XPathParent);
            if (!parentNode) return;

            const targetNode = getNodeFromXPath(MirrorDocumentRef.current!, XPathSelf);
            if (!targetNode) return;

            parentNode.removeChild(targetNode);
        },
        'Add': (XPathParent: string, Node: Node, XPathSibling: string | null) => {

            if (!XPathParent || !Node) {
                console.error("UpdateMirrorDocument.Add: Invalid Parameter");
                return;
            }

            const parentNode = getNodeFromXPath(MirrorDocumentRef.current!, XPathParent);
            if (!parentNode) return;

            const targetNode = Node;
            if (!targetNode) return;

            let SiblingNode = null
            if (XPathSibling) {
                SiblingNode = getNodeFromXPath(MirrorDocumentRef.current!, XPathSibling);
                if (SiblingNode === undefined)
                    SiblingNode = null;
            }

            parentNode.insertBefore(targetNode, SiblingNode);
        }
    }

    useLayoutEffect(() => {


        if (!WatchElementRef.current) {
            return;
        }

        toggleObserve(true);

        // clean up
        return () => {
            toggleObserve(false);
        }

    });

    useLayoutEffect(() => {

        if (!WatchElementRef.current || !MirrorDocumentRef.current) {
            return;
        }
        const WatchedElement = WatchElementRef.current;
        const contentEditableCached = WatchedElement.contentEditable;

        if (EditableElement) {

            WatchedElement.contentEditable = 'true';

            // !!plaintext-only actually introduces unwanted behavior
            // try {
            //     WatchedElement.contentEditable = 'plaintext-only';
            // } catch (e) {
            //     // WatchedElement.contentEditable = 'true';
            //     throw e;
            // }
        }

        const flushQueueDebounced = _.debounce(FlushQueue, 500);

        // bind Events
        const InputHandler = (ev: Event) => {
            console.log("input")
            flushQueueDebounced();
        }
        WatchedElement.addEventListener("input", InputHandler);

        const PastHandler = (ev: ClipboardEvent) => {
            console.log("paste")
            flushQueueDebounced();
        }
        WatchedElement.addEventListener("paste", PastHandler);

        return () => {
            WatchedElement.contentEditable = contentEditableCached;
            WatchedElement.removeEventListener("input", InputHandler);
            WatchedElement.removeEventListener("paste", PastHandler);
        }


    }, [WatchElementRef.current!])
}


function getNodeFromXPath(doc: Document, XPath: string) {
    if (!doc) {
        console.error("getNodeFromXPath: Invalid Doc");
        return;
    }
    return doc.evaluate(XPath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
}