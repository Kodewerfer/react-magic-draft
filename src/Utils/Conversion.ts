import React, {} from "react";
import * as reactJsxRuntime from 'react/jsx-runtime'
import {unified} from "unified";
import {Compatible} from "unified/lib";
import {u} from 'unist-builder'

import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import remarkStringify from "remark-stringify";
import rehypeParse from "rehype-parse";
import rehypeReact from "rehype-react";
import rehypeSanitize, {defaultSchema} from "rehype-sanitize";
import rehypeRemark from "rehype-remark";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";

import HandleCustomDirectives from "../UnifiedPlugins/HandleCustomDirectives";

let SanitizSchema = Object.assign({}, defaultSchema);
SanitizSchema!.attributes!['*'] = SanitizSchema!.attributes!['*'].concat(['data*'])

export async function MD2HTML(MarkdownContent: Compatible) {
    
    return await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkDirective)
        .use(HandleCustomDirectives)
        .use(remarkRehype)
        .use(rehypeSanitize, SanitizSchema)
        .use(rehypeStringify)
        .process(MarkdownContent);
}

export function MD2HTMLSync(MarkdownContent: Compatible) {
    return unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkDirective)
        .use(HandleCustomDirectives)
        .use(remarkRehype)
        .use(rehypeSanitize, SanitizSchema)
        .use(rehypeStringify)
        .processSync(MarkdownContent);
}

// @ts-expect-error: the react types are missing.
const jsxElementConfig = {Fragment: reactJsxRuntime.Fragment, jsx: reactJsxRuntime.jsx, jsxs: reactJsxRuntime.jsxs}

export async function HTML2React(HTMLContent: Compatible, componentOptions?: Record<string, React.FunctionComponent<any>>) {
    
    return await unified()
        .use(rehypeParse, {fragment: true})
        .use(rehypeSanitize, SanitizSchema) //this plug remove some attrs/aspects that may be important.
        .use(rehypeReact, {
            ...jsxElementConfig,
            components: componentOptions
        })
        .process(HTMLContent);
}

export function HTML2ReactSnyc(HTMLContent: Compatible, componentOptions?: Record<string, React.FunctionComponent<any>>) {
    
    return unified()
        .use(rehypeParse, {fragment: true})
        .use(rehypeSanitize, SanitizSchema) //this plug remove some attrs/aspects that may be important.
        .use(rehypeReact, {
            ...jsxElementConfig,
            components: componentOptions
        })
        .processSync(HTMLContent);
}

export async function HTML2MD(CurrentContent: Compatible) {
    
    return await unified()
        .use(rehypeParse)
        .use(remarkGfm)
        .use(rehypeRemark, {
            handlers: {
                'br': (State, Node) => {
                    const result = u('text', ':br');
                    State.patch(Node, result);
                    return result;
                }
            }
        })
        .use(remarkStringify)
        .process(CurrentContent);
    
}