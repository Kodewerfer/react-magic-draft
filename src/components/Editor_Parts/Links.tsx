import React, {useContext, useLayoutEffect, useRef, useState} from "react";
import {TDaemonReturn} from "../hooks/useEditorDaemon";
import {
    GetAllSurroundingText,
    GetCaretContext
} from "../Utils/Helpers";
import {TActivationReturn} from "../Editor_Types";
import {CompileAllTextNode, UpdateComponentAndSync} from "./Utils/CommonFunctions";
import {RecalibrateContainer} from "../context/ParentElementContext";
import classNames from "classnames/dedupe";

/**
 *  In current implementation, the Link component is a special kind of "plainSyntax" component which are in-line elements in nature
 *  Many of the functionalities are the same, but since link have some specialities and may undergo changes, the code are kept seperated.
 * */

export default function Links({children, tagName, daemonHandle, ...otherProps}: {
    children?: React.ReactNode[] | React.ReactNode;
    tagName: string;
    daemonHandle: TDaemonReturn;
    [key: string]: any; // for otherProps
}) {
    
    const [SetActivation] = useState<(state: boolean) => TActivationReturn>(() => {
        return ComponentActivation;
    }); // the Meta state, called by parent via dom fiber
    
    const [isEditing, setIsEditing] = useState(false); //Reactive state, toggled by the meta state
    
    // the element tag
    const LinkElementRef = useRef<HTMLElement | null>(null);
    const LinkAddrRef = useRef<HTMLElement | null>(null);
    const LinkedContentMapRef = useRef(new Map<HTMLElement | Node, boolean>())
    
    const ElementOBRef = useRef<MutationObserver | null>(null);
    
    const ParentAction = useContext(RecalibrateContainer);
    
    function ComponentActivation(state: boolean): TActivationReturn {
        
        const ComponentReturn = {
            "enter": HandleEnter,
            element: LinkElementRef.current
        }
        
        // send whatever within the text node before re-rendering to the processor
        if (!state) {
            
            ElementOBRef.current?.takeRecords();
            ElementOBRef.current?.disconnect();
            ElementOBRef.current = null;
            
            if (typeof ParentAction === "function")
                ParentAction();
            
            else if (LinkElementRef.current) {
                
                const TextContent = CompileAllTextNode(LinkElementRef.current);
                UpdateComponentAndSync(daemonHandle, TextContent, LinkElementRef.current);
                
            }
        }
        if (state) {
            daemonHandle.SyncNow();
            
            if (typeof MutationObserver) {
                ElementOBRef.current = new MutationObserver(ObserverHandler);
                LinkElementRef.current && ElementOBRef.current?.observe(LinkElementRef.current, {
                    childList: true,
                    subtree: true
                });
            }
        }
        setIsEditing(state);
        
        return ComponentReturn;
    }
    
    function ObserverHandler(mutationList: MutationRecord[]) {
        mutationList.forEach((Record) => {
            if (!Record.removedNodes.length) return;
            
            Record.removedNodes.forEach((Node) => {
                if (Node === LinkAddrRef.current || LinkedContentMapRef.current.get(Node)) {
                    
                    if (typeof ParentAction === "function")
                        return ParentAction();
                    
                    const TextContent = CompileAllTextNode(LinkElementRef.current!);
                    UpdateComponentAndSync(daemonHandle, TextContent, LinkElementRef.current);
                }
            })
        })
    }
    
    function HandleEnter(ev: Event) {
        ev.preventDefault();
        
        const {CurrentSelection} = GetCaretContext();
        
        let bShouldBreakLine = true;
        
        const TextContent = CompileAllTextNode(LinkElementRef.current!);
        
        const {precedingText, followingText} = GetAllSurroundingText(CurrentSelection!, LinkElementRef.current!);
        
        if (precedingText.trim() === '')
            daemonHandle.SetFutureCaret("PrevElement");
        else if (followingText.trim() !== '')
            bShouldBreakLine = false;
        else
            daemonHandle.SetFutureCaret("NextElement");
        
        if (typeof ParentAction === "function")
            ParentAction();
        else
            UpdateComponentAndSync(daemonHandle, TextContent, LinkElementRef.current);
        
        return Promise.resolve(bShouldBreakLine);
    }
    
    // Like other in-line components, the component's node are exempt from ob, all updates are handled via addops in ComponentActivation
    useLayoutEffect(() => {
        
        if (typeof children === 'string') children = children.trim();
        
        if (LinkElementRef.current && LinkElementRef.current?.firstChild)
            daemonHandle.AddToIgnore([...LinkElementRef.current.childNodes], "any", true);
    });
    
    // effectively add all "children" to LinkedContentMapRef.current
    // Link can wrap other in-line elements
    useLayoutEffect(() => {
        if (LinkElementRef.current && LinkElementRef.current.childNodes.length) {
            Array.from(LinkElementRef.current.childNodes).some((child) => {
                if (child.nodeType === Node.ELEMENT_NODE && !(child as HTMLElement).hasAttribute("data-is-generated")) {
                    LinkedContentMapRef.current.set(child as HTMLElement, true);
                    return true;
                }
                
                if (child.nodeType === Node.TEXT_NODE) {
                    LinkedContentMapRef.current.set(child as HTMLElement, true);
                    return true;
                }
            })
        }
        return () => {
            LinkedContentMapRef.current.clear();
        }
    });
    
    // Add component classed on top of classes that may be added to it
    const combinedClassnames = classNames(
        LinkElementRef?.current?.className,
        `http-link`,
        {"is-active": isEditing}
    )
    
    return React.createElement(tagName, {
        ...otherProps,
        className: combinedClassnames,
        ref: LinkElementRef,
    }, [
        <span className={`Text-Normal ${isEditing ? "" : 'Hide-It'}`}
              data-is-generated={true}
              key={'SyntaxFrontBracket'}>
             {'\u00A0'}
            <span contentEditable={false}>[</span>
        </span>,
        // link text
        ...(Array.isArray(children) ? children : [children]),
        
        <span className={`Text-Normal ${isEditing ? "" : 'Hide-It'}`}
              data-is-generated={true} contentEditable={false}
              key={'SyntaxRearBracket'}>{']'}</span>,
        // the link address
        <span className={`Text-Normal ${isEditing ? "" : 'Hide-It'}`}
              data-is-generated={true}
              key={'SyntaxLinkAddr'}>
            <span ref={LinkAddrRef}>{`(${otherProps['href'] || ''})\u00A0`}</span>
        </span>,
    ]);
}