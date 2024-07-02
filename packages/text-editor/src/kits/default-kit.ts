//
// Copyright © 2023 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { codeBlockOptions, codeOptions } from '@hcengineering/text'
import { Extension } from '@tiptap/core'
import type { CodeOptions } from '@tiptap/extension-code'
import type { CodeBlockOptions } from '@tiptap/extension-code-block'
import type { HardBreakOptions } from '@tiptap/extension-hard-break'
import type { Level } from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import Typography from '@tiptap/extension-typography'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'

export interface DefaultKitOptions {
  codeBlock?: Partial<CodeBlockOptions> | false
  code?: Partial<CodeOptions> | false
  hardBreak?: Partial<HardBreakOptions> | false
  heading?: {
    levels?: Level[]
  }
  history?: false
}

export const DefaultKit = Extension.create<DefaultKitOptions>({
  name: 'defaultKit',

  addExtensions () {
    return [
      StarterKit.configure({
        blockquote: {
          HTMLAttributes: {
            class: 'proseBlockQuote'
          }
        },
        code: this.options.code ?? codeOptions,
        codeBlock: this.options.codeBlock ?? codeBlockOptions,
        hardBreak: this.options.hardBreak,
        heading: this.options.heading,
        history: this.options.history
      }),
      Underline,
      Highlight.configure({
        multicolor: false
      }),
      Typography.configure({}),
      Link.configure({
        openOnClick: true,
        HTMLAttributes: { class: 'cursor-pointer', rel: 'noopener noreferrer', target: '_blank' }
      })
    ]
  }
})
