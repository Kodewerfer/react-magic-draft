import React, {
    ForwardedRef,
    forwardRef,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState
} from "react";
import {HTML2MDSync, HTML2ReactSync, HTMLCleanUP, MD2HTMLAsync} from "./Utils/Conversion";
import useEditorDaemon, {ParagraphTest, TSelectionStatus} from "./hooks/useEditorDaemon";
import {Compatible} from "unified/lib";
import "./Editor.css";

// helper
import {
    TextNodeProcessor,
    FindWrappingElementWithinContainer,
    GetCaretContext,
    MoveCaretIntoNode,
    GetNextSiblings,
    MoveCaretToNode
} from "./Utils/Helpers";
// Editor Components
import Paragraph from './Editor_Parts/Paragraph';
import PlainSyntax from "./Editor_Parts/PlainSyntax";
import Links from "./Editor_Parts/Links";
import {Blockquote, QuoteItem} from "./Editor_Parts/Blockquote";
import {ListContainer, ListItem} from "./Editor_Parts/List";
import {CodeItem, Preblock} from "./Editor_Parts/Preformatted";
import {TActivationReturn} from "./Editor_Types";
import FileLink from "./Editor_Parts/FileLink";
import {CompileAllTextNode, CompileDisplayTextNodes} from "./Editor_Parts/Utils/CommonFunctions";

export type TEditorForwardRef = {
    FlushChanges: () => Promise<void>;
    ExtractMD: () => Promise<string>;
    ExtractCaretData: () => TSelectionStatus | null;
    SetCaretData: (caretData: TSelectionStatus, ShouldOverride?: boolean) => void;
    InsertText: (TextContent: string, bSyncAfterInsert?: boolean) => void;
    GetDOM: () => {
        root: HTMLElement | null,
        editor: HTMLElement | null,
        mask: HTMLElement | null
    }
}

export type TComponentCallbacks = {
    FileLinks?: {
        initCallback?: (linkTarget: string) => void | Promise<void>;
        removeCallback?: (linkTarget: string) => void | Promise<void>;
    }
}

export type TEditorCallbacks = {
    OnInit: (HTMLString: string) => void;
    OnReload: (HTMLString: string) => void;
}

export type TEditorProps = {
    SourceData?: string | undefined;
    KeepBrs?: boolean;
    EditorCallBacks?: TEditorCallbacks;
    ComponentCallbacks?: TComponentCallbacks;
    DebounceSyncDelay?: number;
    DaemonShouldLog?: boolean;
    IsEditable?: boolean;
    AutoFocus?: boolean;
    HistoryLength?: number;
    [key: string]: any; // for otherProps
};

type TActivationCache = {
    fiber: Object | null;
    func: ((arg: boolean) => TActivationReturn) | null | undefined;
    return: TActivationReturn | null;
    id: null | string;
    // wrapperFiber: any | null; //NOTE: due to how mapping converted component works, only the anonymous component one level higher have a valid key
}

const AutoCompleteSymbols = /([*~`"(\[{])/;
const AutoCompletePairsMap = new Map([
    ["[", "]"],
    ["(", ")"],
    ["{", "}"]
]);


function EditorActual(
    {
        SourceData,
        KeepBrs = true,
        ComponentCallbacks,
        EditorCallBacks,
        DebounceSyncDelay = 500,
        DaemonShouldLog = true,
        IsEditable = true,
        AutoFocus = true,
        HistoryLength = 10,
        ...otherProps
    }: TEditorProps,
    ref?: ForwardedRef<TEditorForwardRef>,
) {
    // DOM element refs, can be extracted via GetDOM()
    const EditorWrapperRef = useRef<HTMLElement | null>(null); //use to export outside only
    const EditorElementRef = useRef<HTMLElement | null>(null);
    const EditorMaskRef = useRef<HTMLDivElement | null>(null);
    // Internal data's ref
    const SourceHTMLStringRef = useRef(''); //HTML string before converted into react components, will be exposed via OnReload() callback
    const MirrorDocRef = useRef<Document | null>(null); //passed into Deamon
    
    const [EditorComponents, setEditorComponents] = useState<React.ReactNode>(null);
    
    // Cache of the last activated components
    const LastActivationCache = useRef<TActivationCache[]>([]);
    const LastActiveAnchor = useRef<Node | null>(null); //compare with this only works before page re-rendering
    
    // First time loading, also dealing with empty source
    useEffect(() => {
        ;(async () => {
            const MDData = SourceData || '';
            // convert MD to HTML
            const convertedHTML: string = String(await MD2HTMLAsync(MDData));
            const CleanedHTML = HTMLCleanUP(convertedHTML);
            let SourceHTMLString = String(CleanedHTML);
            
            // Save a copy of HTML
            const HTMLParser = new DOMParser();
            MirrorDocRef.current = HTMLParser.parseFromString(SourceHTMLString, "text/html");
            
            // save a text copy
            SourceHTMLStringRef.current = SourceHTMLString;
            
            let reactConversion = await ConfigAndConvertToReact(SourceHTMLString);
            
            // load editor component
            setEditorComponents(reactConversion.result)
            
            if (typeof EditorCallBacks?.OnInit === "function") {
                console.log("Editor init complete, calling EditorCallBacks OnInit");
                EditorCallBacks.OnInit(SourceHTMLStringRef.current);
            }
        })()
        
    }, [SourceData]);
    
    // Subsequence reload by daemon
    async function OnDaemonFinishedProcessing() {
        if (!MirrorDocRef.current) return;
        const MirrorDocBodyElement: HTMLBodyElement | null = MirrorDocRef.current.documentElement.querySelector('body');
        if (!MirrorDocBodyElement) {
            console.error("Mirror Doc body element is null");
            return;
        }
        MirrorDocBodyElement.normalize();
        
        const CleanedHTML = HTMLCleanUP(MirrorDocBodyElement.innerHTML);
        
        SourceHTMLStringRef.current = String(CleanedHTML);
        MirrorDocBodyElement.innerHTML = String(CleanedHTML);
        
        // const HTMLParser = new DOMParser();
        // MirrorDocRef.current = HTMLParser.parseFromString(String(CleanedHTML), "text/html");
        
        let reactConversion = ConfigAndConvertToReact(SourceHTMLStringRef.current);
        setEditorComponents(reactConversion.result);
        // caller's interface
        if (typeof EditorCallBacks?.OnReload === "function") {
            console.log("Editor synced, reloading complete,calling EditorCallBacks OnReload");
            EditorCallBacks.OnReload(SourceHTMLStringRef.current);
        }
    }
    
    // FIXME: this structure is getting unwieldy, find a way to refactor.
    const ComponentRenderConditions = (props: any, tagName: string) => {
        // Key is generated each time in AddIDToElement
        // TODO: will result in a complete reload, performance optimization needed for large files
        const CompoKey = props['data-key'];
        if (props['data-md-syntax'] && props['data-md-inline']) {
            return <PlainSyntax {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-file-link']) {
            return <FileLink {...props} key={CompoKey} removeCallback={ComponentCallbacks?.FileLinks?.removeCallback}
                             initCallback={ComponentCallbacks?.FileLinks?.initCallback} daemonHandle={DaemonHandle}
                             tagName={tagName}/>;
        }
        if (props['data-md-link']) {
            return <Links {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-blockquote'] === 'true') {
            return <Blockquote {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-quote-item'] === 'true') {
            return <QuoteItem {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-list'] === 'true') {
            return <ListContainer {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-list-item'] === 'true') {
            return <ListItem {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-preformatted'] === 'true') {
            return <Preblock {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-pre-item'] === 'true' && props['data-md-code'] === 'true') {
            return <CodeItem {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-code'] === 'true') {
            return <PlainSyntax {...props} key={CompoKey} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        if (props['data-md-paragraph'] || props['data-md-header']) {
            return <Paragraph {...props} key={CompoKey} isHeader={props['data-md-header'] !== undefined}
                              headerSyntax={props['data-md-header']} daemonHandle={DaemonHandle} tagName={tagName}/>;
        }
        // fallback
        return <CommonRenderer {...props} key={CompoKey} tagName={tagName}/>;
    };
    
    function ConfigAndConvertToReact(md2HTML: Compatible) {
        
        // Map all possible text-containing tags to TextContainer component and therefore manage them.
        const TextNodesMappingConfig: Record<string, React.FunctionComponent<any>> = [
            'p', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol',
            'li', 'code', 'pre', 'em', 'strong', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
            'br', 'img', 'del', 'input', 'hr'
        ].reduce((acc: Record<string, React.FunctionComponent<any>>, tagName: string) => {
            acc[tagName] = (props: any) => ComponentRenderConditions(props, tagName);
            return acc;
        }, {});
        
        const componentOptions = {
            ...TextNodesMappingConfig
        }
        return HTML2ReactSync(md2HTML, componentOptions);
    }
    
    // Will be called by the Daemon
    function MaskEditingArea() {
        
        if (!EditorMaskRef.current || !EditorMaskRef.current.innerHTML) return;
        
        const editorInnerHTML = EditorElementRef.current?.innerHTML;
        if (editorInnerHTML) {
            EditorElementRef.current?.classList.add("No-Vis");
            EditorMaskRef.current!.innerHTML = editorInnerHTML;
            EditorMaskRef.current!.classList.remove("Hide-It");
        }
        
        // return the Unmask function for the Daemon
        return () => {
            if (!EditorElementRef.current || !EditorMaskRef.current) return;
            EditorElementRef.current.classList.remove("No-Vis");
            EditorMaskRef.current.classList.add('Hide-It');
            EditorMaskRef.current.innerHTML = " ";
        }
    }
    
    // - Forward ref functions
    
    async function FlushChanges() {
        return DaemonHandle.SyncNow();
    }
    
    function GetDOM() {
        return {
            root: EditorWrapperRef.current,
            editor: EditorElementRef.current,
            mask: EditorMaskRef.current
        }
    }
    
    function InsertText(TextContent: string, bSyncAfterInsert: boolean = true) {
        
        EditorElementRef.current?.focus();
        
        let {
            PrecedingText,
            SelectedText,
            RemainingText,
            TextAfterSelection,
            CurrentSelection,
            CurrentAnchorNode
        } = GetCaretContext();
        if (!CurrentSelection || CurrentAnchorNode === EditorElementRef.current) return;
        // immediately collapse the selection
        if (!CurrentSelection.isCollapsed) {
            CurrentSelection.collapseToEnd();
            ({
                PrecedingText,
                TextAfterSelection,
                CurrentSelection,
                CurrentAnchorNode
            } = GetCaretContext());
        }
        
        if (!CurrentSelection || !CurrentAnchorNode || !CurrentSelection.focusNode) return;
        const NearestContainer = FindWrappingElementWithinContainer(CurrentAnchorNode, EditorElementRef.current!)
        if (!NearestContainer) return;
        if (CurrentAnchorNode.nodeType !== Node.TEXT_NODE && CurrentAnchorNode !== NearestContainer) return;
        
        let OldRange = {
            startOffset: CurrentSelection.getRangeAt(0).startOffset || 0,
        };
        
        // insert the text
        CurrentAnchorNode.textContent = PrecedingText + String(TextContent);
        if (TextAfterSelection) {
            CurrentAnchorNode.textContent += TextAfterSelection;
        }
        
        // reset the caret position
        const selection = window.getSelection();
        if (!selection) return;
        try {
            const NewRange = document.createRange();
            NewRange.setStart(CurrentAnchorNode, (OldRange.startOffset + TextContent.length) || 0);
            
            selection.removeAllRanges()
            selection.addRange(NewRange);
        } catch (e) {
            console.warn(e);
        }
        
        if (bSyncAfterInsert)
            DaemonHandle.SyncNow();
    }
    
    // function that extract HTML content from editor, will be called by parent component with forward ref
    async function ExtractMD() {
        await DaemonHandle.SyncNow();
        // console.warn("Extracting Markdown, Daemon synced.");
        const ConvertedMarkdown = await HTML2MDSync(SourceHTMLStringRef.current, {keepBrs: KeepBrs});
        return String(ConvertedMarkdown);
    }
    
    // return the selection status from the daemon to parent of the editor
    function ExtractCaretData() {
        return DaemonHandle.GetSelectionStatus();
    }
    
    function SetCaretData(caretData: TSelectionStatus, ShouldOverride?: boolean) {
        return DaemonHandle.SetSelectionStatus(caretData, ShouldOverride);
    }
    
    // expose the extraction to parent
    useImperativeHandle(ref, () => ({
        FlushChanges,
        ExtractMD,
        ExtractCaretData,
        SetCaretData,
        InsertText,
        GetDOM
    }));
    
    
    // Editor level selection status monitor
    const ComponentActivationSwitch = () => {
        // console.log("Switching activation")
        const selection: Selection | null = window.getSelection();
        if (!selection) return;
        // Must be an element of the current editor
        if (!EditorElementRef.current?.contains(selection?.anchorNode)) return;
        
        let ActiveComponentsStack = LastActivationCache.current;
        if (!ActiveComponentsStack) return;
        // The top most active component, used for comparing
        const TopActiveComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        
        // Must not contains multiple elements
        if (!selection.isCollapsed) {
            if (selection.anchorNode === selection.focusNode)
                return;
            
            // No active component
            if (!ActiveComponentsStack.length) return;
            
            if (!TopActiveComponent || typeof TopActiveComponent.func !== 'function') return;
            
            // Switch off last activation if drag selection passed the last element
            const {
                compFiber: endPointFiber
            }: any = FindActiveEditorComponentFiber(selection.focusNode! as HTMLElement);
            
            if (endPointFiber && endPointFiber !== TopActiveComponent.fiber) {
                let ActiveComponent;
                while (ActiveComponent = ActiveComponentsStack.pop()) {
                    if (typeof ActiveComponent.func !== 'function') continue;
                    ActiveComponent.func(false);
                }
            }
            return;
        }
        
        if (LastActiveAnchor.current === selection.anchorNode) return;
        // refresh the cache
        LastActiveAnchor.current = selection.anchorNode;
        
        // retrieve the component, set the editing state
        const {
            compFiber: ActiveComponentFiber,
            parentFibers
        }: any = FindActiveEditorComponentFiber(selection.anchorNode! as HTMLElement);
        // FIXME: This is VERY VERY VERY HACKY
        // right now the logic is - for a editor component, the very first state need to be a function that handles all logic for "mark as active"
        // with the old class components, after gettng the components from dom, you can get the "stateNode" and actually call the setState() from there
        if (!ActiveComponentFiber) return;
        if (TopActiveComponent && (TopActiveComponent.fiber === ActiveComponentFiber)) return;
        
        // console.log("Active fiber ", ActiveComponentFiber, " ", selection.anchorNode);
        
        // Switch off all currently activated
        let ActiveComponent;
        while (ActiveComponent = ActiveComponentsStack.pop()) {
            if (typeof ActiveComponent.func !== 'function') continue;
            ActiveComponent.func(false);
        }
        
        let keyPathFull = '';
        let keyLast: string | null = null;
        
        // switch on the new ones, parent components first
        parentFibers.forEach((fiber: any) => {
            keyPathFull += fiber.id || fiber.key || "";
            if ((fiber.id || fiber.key) && keyLast === null) keyLast = fiber.id || fiber.key //store the key so that it can be used latter
            
            let ID = fiber.id || fiber.key;
            
            if (!ID && keyLast) {
                ID = keyLast;
                keyLast = null;
            }
            
            if (!fiber.memoizedState || typeof fiber.memoizedState.memoizedState !== "function") return;
            
            const CachedItem: TActivationCache = {
                fiber: fiber,
                func: fiber.memoizedState.memoizedState,
                return: fiber.memoizedState.memoizedState(true),
                id: ID
            }
            
            ActiveComponentsStack.push(CachedItem);
        })
        // the top-level component
        if (ActiveComponentFiber.memoizedState && typeof ActiveComponentFiber.memoizedState.memoizedState === "function") {
            
            const componentID = ActiveComponentFiber.id || ActiveComponentFiber.key;
            
            ActiveComponentsStack.push({
                fiber: ActiveComponentFiber,
                func: ActiveComponentFiber.memoizedState.memoizedState,
                return: ActiveComponentFiber.memoizedState.memoizedState(true),
                id: componentID ? componentID : keyLast
            });
        }
        
        // console.log("switching finished:", ActiveComponentsStack)
    }
    
    // Functionalities such as wrapping selected text with certain symbols or brackets
    function AutocompleteHandler(KeyboardInput: string, ev: Event) {
        let {
            PrecedingText,
            SelectedText,
            TextAfterSelection,
            CurrentSelection,
            CurrentAnchorNode
        } = GetCaretContext();
        if (!CurrentAnchorNode || !CurrentSelection) return;
        
        const NearestContainer = FindWrappingElementWithinContainer(CurrentAnchorNode, EditorElementRef.current!)
        if (!NearestContainer) return;
        
        // TODO: could cause non-responsiveness, need more testing
        if (CurrentAnchorNode.nodeType !== Node.TEXT_NODE && CurrentAnchorNode !== NearestContainer) return;
        
        // Prep the symbol,"pair" for parentheses or brackets
        let KeyboardInputPair = AutoCompletePairsMap.get(KeyboardInput);
        if (!KeyboardInputPair) KeyboardInputPair = KeyboardInput;
        
        if (CurrentSelection.isCollapsed || !SelectedText) return;
        
        // The "wrapping" functionality only handles selected text to save confusion
        // Wrap the selected content
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        ev.preventDefault();
        
        let OldRange = {
            startOffset: CurrentSelection.getRangeAt(0).startOffset || 0,
            endOffset: CurrentSelection.getRangeAt(0).endOffset || 0,
        };
        
        /**
         *  When double click to select text, the selection may include preceding or tailing whitespace,
         *  the extra ws will break the conversion. eg: *strong* is fine, but *strong * will not immediately convert to strong tag.
         *  in this case, remove the ws from selection, and then add them back in their original position
         */
            
            // Padding for whitespace that was removed
        let LeftPadding = '';
        let RightPadding = '';
        
        if (SelectedText.trim() !== SelectedText) {
            if (SelectedText.startsWith(" ")) {
                LeftPadding = " ";
                OldRange.startOffset += 1;
            }
            if (SelectedText.endsWith(" ")) {
                RightPadding = " ";
                OldRange.startOffset -= 1;
            }
        }
        
        CurrentAnchorNode.textContent = PrecedingText + LeftPadding + KeyboardInput + SelectedText.trim() + KeyboardInputPair;
        if (TextAfterSelection) {
            CurrentAnchorNode.textContent += (RightPadding + TextAfterSelection);
        }
        
        const selection = window.getSelection();
        if (!selection) return;
        
        let NewRange = document.createRange();
        
        try {
            NewRange.setStart(CurrentAnchorNode, OldRange.startOffset + KeyboardInput.length || 0);
            
            if (TextAfterSelection) {
                NewRange.setEnd(CurrentAnchorNode, OldRange.endOffset + KeyboardInputPair.length || 0);
            } else {
                NewRange.setEnd(CurrentAnchorNode, CurrentAnchorNode.textContent.length - KeyboardInputPair.length);
            }
            
            selection.removeAllRanges()
            selection.addRange(NewRange);
            
        } catch (e) {
            console.warn(e);
        }
        
        return;
    }
    
    /**
     * Following are the logics to handle key presses
     * The idea is that these are the "generic" logic handling line breaking/joining, sometimes using only vanilla content editable logic.
     * if subcomponents need to have their own logic on these keys, they are injected via state function return and stored in "ActivationCallbacksRef.current"
     * when no special logic is present, the "generic" logic would run.
     */
    async function EnterKeyHandler(ev: HTMLElementEventMap['keydown']) {
        // Run the component spec handler if present
        // if the callback returns 'true', continue the editor's logic
        let LastComponentKey = null;
        let LatestCallbackReturn: void | boolean = undefined;
        let bComponentEnterUsed = false;
        
        let ActiveComponentsStack = LastActivationCache.current;
        if (!ActiveComponentsStack) return;
        // The top most active component, used for comparing
        let TopActiveComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        
        // console.warn(ActiveComponentsStack)
        // console.warn(TopActiveComponent)
        
        // Run "current component"'s enter key logic until there is none or encountered self again.
        // This is to deal with changed caret position and therefore changed active component after enter key.
        while (TopActiveComponent && typeof TopActiveComponent.return?.enter === 'function' && (TopActiveComponent.id && TopActiveComponent.id !== LastComponentKey)) {
            bComponentEnterUsed = true;
            LastComponentKey = TopActiveComponent.id;  //NOTE: this can be the key of the wrapping anonymous component
            console.log("Component spec Enter, key:", LastComponentKey);
            LatestCallbackReturn = await TopActiveComponent.return.enter(ev);
            // re-acquire the "current" top element(assuming the caret moved)
            TopActiveComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        }
        
        if (bComponentEnterUsed && LatestCallbackReturn !== true)
            return
        // NOTE: Old implementation, this will only run the component enter key only once, no longer suited for the async/await structure.
        // if (typeof LastActivationCache.current.return?.enter === 'function') {
        //     console.log("Component Enter key")
        //     const CallbackReturn = await LastActivationCache.current.return?.enter(ev);
        //
        //     if (CallbackReturn !== true)
        //         return
        // }
        
        // run parent-level enter key handling
        // container-like parent usually have special handling for enter key, in case of multi-level component with those containers, this is acts as "failsafe"
        // starts from second to last element
        for (let i = ActiveComponentsStack.length - 2; i >= 0; i--) {
            const parentComponent = ActiveComponentsStack[i];
            
            if (typeof parentComponent.return?.enter === 'function') {
                
                console.log("Parent level Enter key ", parentComponent.id);
                
                if (parentComponent.return.enter(ev) !== true) return;
            }
            
        }
        
        ev.preventDefault();
        ev.stopPropagation();
        
        // Normal logic
        let {RemainingText, PrecedingText, CurrentSelection, CurrentAnchorNode} = GetCaretContext();
        if (!CurrentSelection || !CurrentAnchorNode) return;
        
        // Collapse selection, otherwise expanded selection may extend to the new line and cause weird behaviors.
        if (!CurrentSelection.isCollapsed) return CurrentSelection.collapseToEnd();
        
        if ((CurrentAnchorNode as HTMLElement)?.contentEditable === 'false' || (CurrentAnchorNode.parentNode as HTMLElement)?.contentEditable === 'false' || CurrentAnchorNode.textContent === '\n') {
            console.warn("Enter Key Exception, not a valid node", CurrentAnchorNode);
            DaemonHandle.SetFutureCaret("NextElement");
            DaemonHandle.SyncNow();
            return;
        }
        let NearestContainer: HTMLElement | null = FindWrappingElementWithinContainer(CurrentAnchorNode, EditorElementRef.current!);
        if (!NearestContainer) return; //unlikely
        
        // Check if caret at an empty line
        const bEmptyLine = NearestContainer === CurrentAnchorNode || (NearestContainer?.childNodes.length === 1 && NearestContainer.childNodes[0].nodeName.toLowerCase() === 'br');
        
        // Empty line when caret landed on the p tag itself. the NearestContainer would be the p tag
        if (bEmptyLine && NearestContainer.firstChild) {
            RemainingText = '';
            PrecedingText = '';
            CurrentAnchorNode = NearestContainer.firstChild;
        }
        
        // Caret usually land on a text node, get the wrapping element
        let Current_ElementNode = FindWrappingElementWithinContainer(CurrentAnchorNode, NearestContainer);
        if (!Current_ElementNode) return; //unlikly
        
        // if landed on a non-editble content, move caret to maintain the smoothness
        if (Current_ElementNode.contentEditable === 'false') {
            const followingElements = GetNextSiblings(Current_ElementNode);
            const moveToNode = followingElements.find(element => {
                return (element as HTMLElement).contentEditable !== 'false'
            })
            MoveCaretToNode(moveToNode);
            return;
        }
        
        // Breaking in an empty line
        if (bEmptyLine && CurrentAnchorNode.nodeName.toLowerCase() === 'br') {
            console.log('Breaking - Empty line');
            
            const NewLine = document.createElement("p");  // The new line
            const lineBreakElement: HTMLBRElement = document.createElement("br");
            NewLine.appendChild(lineBreakElement);
            
            DaemonHandle.AddToOperations({
                type: "ADD",
                newNode: NewLine,
                siblingNode: NearestContainer,
                parentXP: "//body"
            });
            DaemonHandle.SetFutureCaret('NextLine');
            DaemonHandle.SyncNow();
            return;
        }
        
        const Range = CurrentSelection.getRangeAt(0);
        const bNoValidPreSiblings =
            !Current_ElementNode.previousSibling
            || (Current_ElementNode.previousSibling as HTMLElement).contentEditable === 'false' && !Current_ElementNode.previousSibling.previousSibling;
        
        // Breaking at the very beginning of the line
        if (bNoValidPreSiblings && Range.startOffset === 0) {
            console.log('Breaking - First element');
            
            // A new line with only a br
            const lineBreakElement: HTMLBRElement = document.createElement("br");
            const NewLine = document.createElement("p");  // The new line
            NewLine.appendChild(lineBreakElement);
            
            DaemonHandle.AddToOperations({
                type: "ADD",
                newNode: NewLine,
                siblingNode: NearestContainer,
                parentXP: "//body"
            });
            DaemonHandle.SetFutureCaret("NextLine");
            DaemonHandle.SyncNow();
            return;
        }
        
        let FollowingNodes = GetNextSiblings(Current_ElementNode)
        // Breaking anywhere in the middle of the line
        if (RemainingText !== '' || FollowingNodes.length > 1 || (FollowingNodes.length === 1 && FollowingNodes[0].textContent !== '\n')) {
            console.log("Breaking - Mid line");
            
            // Exception, when caret is on the element tag itself, and didn't fit the previous cases (happens on PlainSyntax primarily)
            if (CurrentAnchorNode.nodeType !== Node.TEXT_NODE) {
                console.warn("Enter Key Exception, move caret to", NearestContainer);
                MoveCaretIntoNode(NearestContainer);
                return;
            }
            
            let anchorNodeClone: Node = CurrentAnchorNode.cloneNode(true);
            if (anchorNodeClone.textContent !== null) anchorNodeClone.textContent = RemainingText;
            const NewLine = document.createElement("p");  // The new line
            NewLine.appendChild(anchorNodeClone);
            
            // Add the following elements in right order
            FollowingNodes.forEach(Node => {
                NewLine.appendChild(Node.cloneNode(true));
            })
            
            // Delete the elements in the old line, need to remove the last one first otherwise the xpath will not be correct
            FollowingNodes.slice().reverse().forEach(Node => {
                DaemonHandle.AddToOperations({
                    type: "REMOVE",
                    targetNode: Node,
                });
            })
            
            // Clean up the old line
            DaemonHandle.AddToOperations({
                type: "TEXT",
                targetNode: CurrentAnchorNode,
                nodeText: PrecedingText
            });
            
            DaemonHandle.AddToOperations({
                type: "ADD",
                newNode: NewLine,
                siblingNode: NearestContainer?.nextSibling,
                parentXP: "//body"
            });
            DaemonHandle.SetFutureCaret('NextLine');
            DaemonHandle.SyncNow();
            
            return;
        }
        
        
        // Breaking at the very end of the line
        console.log("Breaking - End of line");
        
        const lineBreakElement: HTMLBRElement = document.createElement("br");
        const NewLine = document.createElement("p");
        NewLine.appendChild(lineBreakElement);
        
        DaemonHandle.AddToOperations({
            type: "ADD",
            newNode: NewLine,
            siblingNode: NearestContainer?.nextSibling,
            parentXP: "//body"
        });
        
        DaemonHandle.SetFutureCaret("NextLine");
        DaemonHandle.SyncNow();
    }
    
    async function BackSpaceKeyHandler(ev: HTMLElementEventMap['keydown']) {
        const ActiveComponentsStack = LastActivationCache.current;
        const TopActiveComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        
        if (TopActiveComponent && typeof TopActiveComponent.return?.backspaceOverride === 'function') {
            console.log("Backspace: Component Spec Override");
            if (TopActiveComponent.return?.backspaceOverride(ev) !== true)
                return;
            console.log("Backspace: Override returned true, continue editor backspacing");
        }
        
        // basically a reverse of the "delete", but with key differences on "normal join line"
        let {PrecedingText, CurrentSelection, CurrentAnchorNode} = GetCaretContext();
        if (!CurrentAnchorNode) return;
        
        let NearestContainer = FindWrappingElementWithinContainer(CurrentAnchorNode, EditorElementRef.current!)
        if (!NearestContainer) return;
        
        if (NearestContainer === CurrentAnchorNode) {
            console.log("Backspace: Caret on container, move to first child:", NearestContainer.firstChild)
            CurrentAnchorNode = NearestContainer.firstChild
            if (!CurrentAnchorNode) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            // This method is less responsive
            // ev.preventDefault();
            // ev.stopPropagation();
            // MoveCaretToNode(NearestContainer.firstChild, 0);
            // return;
        }
        
        if (ParagraphTest.test(CurrentAnchorNode.nodeName)) {
            console.log("Backspace: Caret on paragraph, move to first child:", CurrentAnchorNode.firstChild);
            CurrentAnchorNode = CurrentAnchorNode.firstChild
            NearestContainer = CurrentAnchorNode;
            if (!CurrentAnchorNode || !NearestContainer) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            
        }
        
        // "normal" text removal conditions
        const bPrecedingValid = PrecedingText.trim() !== '' || (CurrentAnchorNode.previousSibling && CurrentAnchorNode.previousSibling.textContent !== '\n');
        const bAnchorIsTextNode = CurrentAnchorNode.nodeType === Node.TEXT_NODE;
        
        const bIsNonEditable = (CurrentAnchorNode as HTMLElement).contentEditable === "false";
        const bIsParentNonEditable = CurrentAnchorNode.parentNode && (CurrentAnchorNode.parentNode as HTMLElement).contentEditable === "false";
        
        if (bIsNonEditable || (bAnchorIsTextNode && bIsParentNonEditable)) {
            console.log("Backspacing: remove non-editable element")
            return;
        }
        
        // Run the normal key press on in-line editing
        if (bAnchorIsTextNode && bPrecedingValid) return;
        if (CurrentSelection && !CurrentSelection.isCollapsed) return;
        
        // Handle empty container type
        if (CurrentAnchorNode.childNodes.length) {
            const bHaveOtherElement = Array.from(CurrentAnchorNode.childNodes).some((childNode: any) => {
                if (childNode.nodeType === Node.TEXT_NODE && childNode.textContent !== '\n')
                    return true;
                return childNode.nodeType === Node.ELEMENT_NODE && (!(childNode as HTMLElement).hasAttribute("data-is-generated") && (childNode as HTMLElement).contentEditable !== 'false');
                
                
            });
            if (!bHaveOtherElement) console.log("Backspace: container empty, removing");
            if (!bHaveOtherElement) return;
        }
        
        // line joining
        ev.preventDefault();
        ev.stopPropagation();
        
        let previousElementSibling = NearestContainer?.previousElementSibling; //nextsibling could be a "\n"
        if (!previousElementSibling) return; //No more lines following
        
        // when there is still content that could be deleted, but caret lands on the wrong element
        // FIXME: may be buggy, need more testing
        if (CurrentAnchorNode.previousSibling && CurrentAnchorNode.previousSibling !== previousElementSibling) {
            // console.log(CurrentAnchorNode.previousSibling, NearestContainer)
            if (previousElementSibling) {
                console.log("Backspace: Invalid Caret, moving Caret to ", previousElementSibling);
                MoveCaretToLastEOL(window.getSelection(), EditorElementRef.current!);
                
            } else {
                
                console.log("Backspace: Invalid Caret, moving Caret to ", CurrentAnchorNode);
                MoveCaretIntoNode(CurrentAnchorNode);
            }
            
            return
        }
        
        // Moves caret or delete non-editable
        let anchorParent = CurrentAnchorNode.parentNode;
        if (CurrentAnchorNode.parentNode && anchorParent !== NearestContainer) {
            const nearestSibling = GetPrevAvailableSibling(CurrentAnchorNode, NearestContainer);
            if (nearestSibling) {
                
                if ((nearestSibling as HTMLElement).contentEditable === 'false' && nearestSibling.parentNode) {
                    console.log("Backspace: removing non-editable child ", nearestSibling, " from ", nearestSibling.parentNode);
                    nearestSibling.parentNode.removeChild(nearestSibling);
                    return;
                }
                
                console.log("Backspace: Moving Caret to ", nearestSibling);
                MoveCaretToNode(nearestSibling, nearestSibling.textContent ? nearestSibling.textContent.length : 0);
                return;
            }
        }
        
        const bSelfIsEmptyLine = NearestContainer?.childNodes.length === 1 && NearestContainer?.firstChild?.nodeName.toLowerCase() === 'br';
        const bPrevLineEmpty = previousElementSibling?.childNodes.length === 1 && previousElementSibling?.firstChild?.nodeName.toLowerCase() === 'br';
        
        // Backspace previous empty lines
        if (bPrevLineEmpty) {
            console.log("Backspace: Empty Line");
            
            DaemonHandle.AddToOperations({
                type: "REMOVE",
                targetNode: previousElementSibling
            });
            
            MoveCaretToNode(previousElementSibling);
            
            DaemonHandle.SyncNow();
            return;
        }
        
        // self is empty line
        if (bSelfIsEmptyLine) {
            console.log("Backspace: Self Empty Line");
            DaemonHandle.AddToOperations({
                type: "REMOVE",
                targetNode: NearestContainer
            });
            MoveCaretToLastEOL(window.getSelection(), EditorElementRef.current!);
            DaemonHandle.SyncNow();
            return;
        }
        
        // Run the component spec handler if present
        if (TopActiveComponent && typeof TopActiveComponent.return?.backspaceJoining === 'function') {
            console.log("Backspace: Component line joining");
            if (TopActiveComponent.return?.backspaceJoining(ev) !== true)
                return;
        }
        
        // Dealing with container type of element
        if (previousElementSibling.nodeType === Node.ELEMENT_NODE && (previousElementSibling as HTMLElement)?.hasAttribute('data-md-container')) {
            console.log("Backspace: Container Item");
            
            if (previousElementSibling.childElementCount > 1)
                DaemonHandle.AddToOperations({
                    type: "REMOVE",
                    targetNode: (previousElementSibling as HTMLElement).lastElementChild!
                });
            else
                DaemonHandle.AddToOperations({
                    type: "REMOVE",
                    targetNode: previousElementSibling
                });
            
            DaemonHandle.SetFutureCaret('PrevLine');
            DaemonHandle.SyncNow();
            return;
        }
        
        // "Normal" joining lines
        console.log("Backspace: Line Join");
        let NewLine = previousElementSibling.cloneNode(true);
        
        NearestContainer.childNodes.forEach((ChildNode) => {
            NewLine.appendChild(ChildNode.cloneNode(true));
        })
        
        DaemonHandle.AddToOperations({
            type: "REMOVE",
            targetNode: NearestContainer,
        });
        
        DaemonHandle.AddToOperations({
            type: "REPLACE",
            targetNode: previousElementSibling,
            newNode: NewLine
        });
        
        MoveCaretToLastEOL(window.getSelection(), EditorElementRef.current!);
        DaemonHandle.SyncNow();
    }
    
    async function DelKeyHandler(ev: HTMLElementEventMap['keydown']) {
        const ActiveComponentsStack = LastActivationCache.current;
        let TopActiveComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        
        if (TopActiveComponent && typeof TopActiveComponent.return?.delOverride === 'function') {
            console.log("Del: Component Spec Override");
            
            if (TopActiveComponent.return.delOverride(ev) !== true)
                return
            console.log("Del: Override returned true, continue editor Del");
        }
        
        
        let {RemainingText, CurrentSelection, CurrentAnchorNode} = GetCaretContext();
        
        if (!CurrentAnchorNode) return;
        
        let NearestContainer = FindWrappingElementWithinContainer(CurrentAnchorNode, EditorElementRef.current!)
        if (!NearestContainer) return;
        
        if (NearestContainer === CurrentAnchorNode) {
            console.log("Del: Caret on container, move to last child:", NearestContainer.lastChild)
            CurrentAnchorNode = NearestContainer.lastChild
            if (!CurrentAnchorNode) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
        }
        
        if (ParagraphTest.test(CurrentAnchorNode.nodeName)) {
            console.log("Del: Caret on paragraph, move to last child:", CurrentAnchorNode.lastChild);
            CurrentAnchorNode = CurrentAnchorNode.lastChild
            NearestContainer = CurrentAnchorNode;
            if (!CurrentAnchorNode || !NearestContainer) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
        }
        
        const bHasContentToDelete = RemainingText.trim() !== '' || (CurrentAnchorNode.nextSibling && CurrentAnchorNode.nextSibling.textContent !== '\n');
        const bAnchorIsTextNode = CurrentAnchorNode.nodeType === Node.TEXT_NODE;
        
        const bIsNonEditable = (CurrentAnchorNode as HTMLElement).contentEditable === "false";
        const bIsParentNonEditable = CurrentAnchorNode.parentNode && (CurrentAnchorNode.parentNode as HTMLElement).contentEditable === "false";
        
        if (bIsNonEditable || (bAnchorIsTextNode && bIsParentNonEditable)) {
            console.log("Del: remove non-editable element")
            return;
        }
        
        // Expanded selection, use browser defualt logic
        if (bHasContentToDelete && bAnchorIsTextNode) return;   // NOTE: when deleting text, default browser logic behaved strangely and will see the caret moving back and forth
        if (CurrentSelection && !CurrentSelection.isCollapsed) return;
        
        // Handle empty container type
        if (CurrentAnchorNode.childNodes.length) {
            const bHaveOtherElement = Array.from(CurrentAnchorNode.childNodes).some((childNode: any) => {
                if (childNode.nodeType === Node.TEXT_NODE && childNode.textContent !== '\n')
                    return true;
                return childNode.nodeType === Node.ELEMENT_NODE && (!(childNode as HTMLElement).hasAttribute("data-is-generated") && (childNode as HTMLElement).contentEditable !== 'false');
                
                
            });
            if (!bHaveOtherElement) console.log("Del: container empty, removing");
            if (!bHaveOtherElement) return;
        }
        
        // line joining
        ev.preventDefault();
        ev.stopPropagation();
        
        // TODO: NOTE: this is an override on editing text, so far only needed for del key
        // TODO: Incomplete,browser's logic cause caret to move back and fourth, but re-implementing involves handling too many edge cases, deemed not worth it, saving for reference.
        // if (!bCaretOnContainer && bHasContentToDelete && bAnchorIsTextNode) {
        //     if (RemainingText !== '') {
        //         CurrentAnchorNode.deleteData(CurrentSelection?.anchorOffset, 1);
        //         return;
        //     }
        //     let nextSibling = CurrentAnchorNode.nextSibling;
        //     if (!nextSibling) return;
        //     // Delete the first character of the next text node
        //     if (nextSibling.nodeType === Node.TEXT_NODE) {
        //         (nextSibling as Text).deleteData(0, 1);
        //         MoveCaretToNode(nextSibling);
        //     }
        //     if (nextSibling.nodeType === Node.ELEMENT_NODE) {
        //         let textNode = GetFirstTextNode(nextSibling);
        //         if (!textNode) return MoveCaretIntoNode(textNode);
        //         (textNode as Text).deleteData(0, 1);
        //         MoveCaretToNode(textNode);
        //     }
        //     return;
        // }
        
        let nextElementSibling = NearestContainer?.nextElementSibling; //nextsibling could be a "\n"
        if (!nextElementSibling) return; //No more lines following
        
        
        // same as back space, when there is still content that could be deleted, but caret lands on the wrong element
        if (CurrentAnchorNode.nextSibling && CurrentAnchorNode.nextSibling !== nextElementSibling) {
            console.log("Del: Invalid Caret, moving Caret to ", CurrentAnchorNode);
            MoveCaretIntoNode(CurrentAnchorNode);
            return;
        }
        
        // Move the caret, mainly dealing with nested node structure with their own text nodes
        let anchorParent = CurrentAnchorNode.parentNode;
        if (CurrentAnchorNode.parentNode && anchorParent !== NearestContainer) {
            const nearestSibling = GetNextAvailableSibling(CurrentAnchorNode, NearestContainer);
            if (nearestSibling) {
                
                if ((nearestSibling as HTMLElement).contentEditable === 'false' && nearestSibling.parentNode) {
                    console.log("Del: removing non-editable child ", nearestSibling, " from ", nearestSibling.parentNode);
                    nearestSibling.parentNode.removeChild(nearestSibling);
                    return;
                }
                
                console.log("Del: Moving Caret to ", nearestSibling);
                MoveCaretToNode(nearestSibling, 0);
                return;
            }
        }
        
        // Line joining logics
        // deleting empty lines
        if (nextElementSibling?.childNodes.length === 1 && nextElementSibling?.firstChild?.nodeName.toLowerCase() === 'br') {
            console.log("Del:Delete Empty Line");
            DaemonHandle.AddToOperations({
                type: "REMOVE",
                targetNode: nextElementSibling
            });
            DaemonHandle.SyncNow();
            return;
        }
        
        // self is empty line
        if (NearestContainer?.childNodes.length === 1 && NearestContainer?.firstChild?.nodeName.toLowerCase() === 'br') {
            console.log("Del:Self Empty Line");
            DaemonHandle.AddToOperations({
                type: "REMOVE",
                targetNode: NearestContainer
            });
            DaemonHandle.SyncNow();
            return;
        }
        
        // Del joining is bug prone, resulting deleting a whole line.
        // run the delJoining() on each level of component
        let bComponentDeJoiningUsed = false;
        let LatestCallbackReturn;
        let checkIndex = 1;
        let CheckForComponent = ActiveComponentsStack[ActiveComponentsStack.length - checkIndex];
        while (CheckForComponent) { //.foreach() won't cut it here, have to use the original reference (ActiveComponentsStack) when the key is pressed.
            if (typeof CheckForComponent.return?.delJoining === 'function') {
                bComponentDeJoiningUsed = true;
                console.log("Component spec del joining used, key:", CheckForComponent.id);
                LatestCallbackReturn = await CheckForComponent.return.delJoining(ev)
            }
            checkIndex++;
            CheckForComponent = ActiveComponentsStack[ActiveComponentsStack.length - checkIndex];
        }
        
        if (bComponentDeJoiningUsed && LatestCallbackReturn !== true) return;
        
        // Old implementation, only check the top-level
        // if (TopActiveComponent && typeof TopActiveComponent.return?.delJoining === 'function') {
        //     console.log("Del: Component Spec line joining");
        //
        //     if (TopActiveComponent.return.delJoining(ev) !== true)
        //         return
        // }
        
        // Dealing with container type of element
        if (nextElementSibling.nodeType === Node.ELEMENT_NODE && (nextElementSibling as HTMLElement)?.hasAttribute('data-md-container')) {
            console.log("Del: Container Item");
            
            if (nextElementSibling.childElementCount > 1)
                DaemonHandle.AddToOperations({
                    type: "REMOVE",
                    targetNode: (nextElementSibling as HTMLElement).firstElementChild!
                });
            else
                // Only one sub element, delete the whole thing
                DaemonHandle.AddToOperations({
                    type: "REMOVE",
                    targetNode: nextElementSibling
                });
            
            DaemonHandle.SyncNow();
            
            return;
        }
        
        
        // "Normal" joining lines
        console.log("Del:Line join");
        
        let NewLine = NearestContainer.cloneNode(true);
        
        nextElementSibling.childNodes.forEach((ChildNode) => {
            NewLine.appendChild(ChildNode.cloneNode(true));
        })
        
        DaemonHandle.AddToOperations({
            type: "REMOVE",
            targetNode: nextElementSibling,
        });
        
        DaemonHandle.AddToOperations({
            type: "REPLACE",
            targetNode: NearestContainer,
            newNode: NewLine
        });
        
        DaemonHandle.SyncNow();
    }
    
    // Copy and cut handlers to handle copy/cut component directly (when the selection is collapsed)
    // copy handler used by cut to acquire active component
    async function CopyHandler(_?: ClipboardEvent) {
        // TODO: removing line breaker is now handled in daemon's paste handler, remove these later
        // will ask for permission, extract text only, as a default(no matter if the selection is expanded)
        // const clipboardText = await navigator.clipboard.readText();
        
        // remove all line breaks
        // await navigator.clipboard.writeText(clipboardText.replace(/\r?\n|\r/g, " "));
        // await navigator.clipboard.writeText(clipboardText || " ");
        
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed) return; //expanded selection will only copy pure text.
        
        let ActiveComponentsStack = LastActivationCache.current;
        const TopComponent = ActiveComponentsStack[ActiveComponentsStack.length - 1];
        if (!TopComponent) return;
        
        const TopComponentElement = TopComponent.return?.element;
        if (TopComponentElement) {
            
            const TextWithSyntax = CompileAllTextNode(TopComponentElement);
            
            await navigator.clipboard.writeText(TextWithSyntax || "");
        }
        
        return TopComponentElement;
        
    }
    
    async function CutHandler(_: ClipboardEvent) {
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed) {
            // extract text only
            const clipboardText = await navigator.clipboard.readText();
            await navigator.clipboard.writeText(clipboardText || " ");
            return;
        }
        
        const ElementToDelete = await CopyHandler();
        if (!ElementToDelete) return;
        
        // normal bowser behavior won't deal with components properly
        DaemonHandle.AddToOperations({
            type: "REMOVE",
            targetNode: ElementToDelete
        });
        DaemonHandle.SyncNow();
    }
    
    
    // Masking and unmasking to hide flicker
    useLayoutEffect(() => {
        if (!EditorElementRef.current || !EditorMaskRef.current) return;
        // After elements are properly loaded, hide the mask to show editor content
        EditorElementRef.current.classList.remove("No-Vis");
        EditorMaskRef.current.classList.add('Hide-It');
        EditorMaskRef.current.innerHTML = " ";
    });
    
    // Editor level selection status monitor
    useLayoutEffect(() => {
        const OnSelectionChange = () => {
            ComponentActivationSwitch();
        }
        const OnSelectStart = () => {
            ComponentActivationSwitch();
        }
        
        document.addEventListener("selectstart", OnSelectStart);
        document.addEventListener("selectionchange", OnSelectionChange);
        
        return () => {
            document.removeEventListener("selectstart", OnSelectStart);
            document.removeEventListener("selectionchange", OnSelectionChange);
        }
        
    }, [EditorElementRef.current, document]);
    
    // Editor level Key handlers, Override keys
    // NOTE: these will fire after daemon's
    useLayoutEffect(() => {
        
        function EditorKeydown(ev: HTMLElementEventMap['keydown']) {
            if (ev.key === "Enter") {
                EnterKeyHandler(ev);
                return;
            }
            if (ev.key === 'Delete') {
                DelKeyHandler(ev);
                return
            }
            if (ev.key === 'Backspace') {
                BackSpaceKeyHandler(ev);
                return;
            }
            if (AutoCompleteSymbols.test(ev.key)) {
                AutocompleteHandler(ev.key, ev);
            }
        }
        
        
        EditorElementRef.current?.addEventListener("keydown", EditorKeydown);
        
        EditorElementRef.current?.addEventListener("copy", CopyHandler);
        EditorElementRef.current?.addEventListener("cut", CutHandler);
        return () => {
            EditorElementRef.current?.removeEventListener("keydown", EditorKeydown);
            
            EditorElementRef.current?.removeEventListener("copy", CopyHandler);
            EditorElementRef.current?.removeEventListener("cut", CutHandler);
        }
    }, [EditorElementRef.current])
    
    const DaemonHandle = useEditorDaemon(EditorElementRef, MirrorDocRef, OnDaemonFinishedProcessing,
        {
            OnRollback: MaskEditingArea,
            DebounceSyncDelay: DebounceSyncDelay,
            TextNodeCallback: TextNodeProcessor,
            ShouldLog: DaemonShouldLog, //detailed logs
            IsEditable: IsEditable,
            ShouldObserve: true,
            ShouldFocus: AutoFocus,
            HistoryLength: HistoryLength,
        });
    
    // Force refreshing the activated component after reloading and caret is restored, needed to be after DaemonHandle's layout effect
    useLayoutEffect(() => {
        ComponentActivationSwitch();
        return () => {
            LastActiveAnchor.current = null;
            LastActivationCache.current = [];
        }
    });
    
    return (
        <>
            <section className="Editor" ref={EditorWrapperRef} {...otherProps}>
                <main className={'Editor-Inner'} ref={EditorElementRef}>
                    {EditorComponents}
                </main>
                <div className={'Editor-Mask'} ref={EditorMaskRef}>
                    Floating Mask To Hide Flickering
                </div>
            </section>
        </>
    )
}

const MagicDraftEditor = forwardRef(EditorActual);
export default MagicDraftEditor;

// the fallback render for any unknown or unspecified elements
// Needed if the like of br is to be rendered normally.
function CommonRenderer(props: any) {
    const {children, tagName, ParentAction, ...otherProps} = props;
    
    return React.createElement(tagName, otherProps, children);
}

// Editor Spec helpers

/**
 * The hack func that retrieves the react fiber and thus the active component
 * NOT: TraverseUp level set to 6, which means it will find parent component up to "3-levels up" eg: blockquote->p->strong
 */
function FindActiveEditorComponentFiber(DomNode: HTMLElement, TraverseUp = 6): any {
    
    const NULL_RETURN = {compFiber: null, parentFiber: null, keyPath: []};
    
    if (DomNode.nodeType === Node.TEXT_NODE) {
        if (DomNode.parentNode)
            DomNode = DomNode.parentNode as HTMLElement
        else {
            console.log("Activation Monitor: Text node without parent");
            return NULL_RETURN;
        }
    }
    // Find the key starting with "__reactFiber$" which indicates a React 18 element
    const key = Object.keys(DomNode).find(key => key.startsWith("__reactFiber$"));
    
    if (!key) return NULL_RETURN;
    
    // Get the Fiber node from the DOM element
    const domFiber = (DomNode as any)[key] as { type?: string; return?: any; stateNode?: any; };
    if (domFiber === undefined) return NULL_RETURN;
    
    // Function to get parent component fiber
    const getCompFiber = (fiber: { type?: string; return?: any; stateNode?: any; }) => {
        let parentFiber = fiber.return;
        while (parentFiber && typeof parentFiber.type === "string") {
            parentFiber = parentFiber.return;
        }
        return parentFiber;
    };
    
    // Get the component fiber and parent fibers
    const compFiber = getCompFiber(domFiber);
    let parentFiber = getCompFiber(domFiber);
    
    let allParentFibers = [];
    
    for (let i = 0; i < TraverseUp; i++) {
        parentFiber = getCompFiber(parentFiber);
        
        if (!parentFiber) break;
        if (parentFiber.id && parentFiber.id.toLowerCase().includes('editor')) break; //reached editor level
        
        allParentFibers.push(parentFiber);
    }
    
    return {compFiber: compFiber, parentFibers: allParentFibers.reverse()};
}

/**
 * Moves the caret to the last end of line (EOL) position within the provided container element.
 * If a current selection is not provided or does not exist, the method will return without performing any action.
 * Used in handling backspace, move caret then sync is more reliable than to set up future token
 *
 * @param {Selection | null} currentSelection - The current selection.
 * @param {HTMLElement} ContainerElement - The container element within which the caret will be moved.
 */
function MoveCaretToLastEOL(currentSelection: Selection | null, ContainerElement: HTMLElement) {
    if (!currentSelection) return;
    let CurrentAnchor = currentSelection.anchorNode;
    if (!CurrentAnchor) return;
    
    const NearestParagraph = FindWrappingElementWithinContainer(CurrentAnchor, ContainerElement);
    
    let currentPrevSibling = NearestParagraph?.previousElementSibling;
    while (currentPrevSibling) {
        if (currentPrevSibling.childNodes.length)
            break
        
        currentPrevSibling = currentPrevSibling.previousElementSibling;
    }
    let ValidLandingPoint;
    for (let i = currentPrevSibling!.childNodes.length - 1; i >= 0; i--) {
        let LastEOLElement = currentPrevSibling!.childNodes[i];
        if (LastEOLElement.nodeType === Node.TEXT_NODE && LastEOLElement.parentNode && (LastEOLElement.parentNode as HTMLElement).contentEditable !== 'false') {
            ValidLandingPoint = LastEOLElement;
            break;
        }
        
        if (LastEOLElement.nodeType === Node.ELEMENT_NODE && (LastEOLElement as HTMLElement).contentEditable !== 'false') {
            ValidLandingPoint = LastEOLElement;
            break;
        }
    }
    if (!ValidLandingPoint || !ValidLandingPoint.textContent) return;
    
    const range = document.createRange();
    try {
        range.collapse(true);
        range.setStart(ValidLandingPoint, ValidLandingPoint.textContent.length);
        currentSelection.removeAllRanges();
        currentSelection.addRange(range);
    } catch (e: any) {
        console.warn(e.message);
    }
    return;
}

/**
 * Returns the next available sibling of a given node within an upper limit.
 *
 * @param {Node | HTMLElement} node - The starting node to find the next available sibling.
 * @param {Node | HTMLElement} upperLimit - The upper limit node to stop the search.
 * @return {Node | null} - The next available sibling or null if not found.
 */
function GetNextAvailableSibling(node: Node | HTMLElement, upperLimit: Node | HTMLElement): Node | null {
    let current = node;
    
    do {
        let nextSibling = current.nextSibling;
        if (nextSibling && (nextSibling.nodeType === Node.ELEMENT_NODE || nextSibling.textContent && nextSibling.textContent !== '\n')) {
            return nextSibling;
        }
        
        current = current.parentNode as Node;
        
    } while (current && current !== upperLimit);
    
    return null;
}

/**
 * Returns the previous available sibling of a given node within a specified upper limit.
 * An available sibling is defined as the previous sibling that is either an element node or has non-empty text content.
 * If no available sibling is found, null is returned.
 *
 * @param {Node | HTMLElement} node - The node to find the previous available sibling for.
 * @param {Node | HTMLElement} upperLimit - The upper limit node to stop searching for the previous sibling.
 * @return {Node | null} - The previous available sibling of the given node, or null if not found.
 */
function GetPrevAvailableSibling(node: Node | HTMLElement, upperLimit: Node | HTMLElement): Node | null {
    let current = node;
    
    do {
        let previousSiblingNode = current.previousSibling;
        if (previousSiblingNode && (previousSiblingNode.nodeType === Node.ELEMENT_NODE || previousSiblingNode.textContent && previousSiblingNode.textContent !== '\n')) {
            return previousSiblingNode;
        }
        
        current = current.parentNode as Node;
        
    } while (current && current !== upperLimit);
    
    return null;
}
