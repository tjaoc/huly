//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { jsonToMarkup, markupToJSON } from '@hcengineering/text'
import { TiptapTransformer, Transformer } from '@hocuspocus/transformer'
import { Extensions } from '@tiptap/core'
import { Doc } from 'yjs'

export class MarkupTransformer implements Transformer {
  transformer: Transformer

  constructor (private readonly extensions: Extensions) {
    this.transformer = TiptapTransformer.extensions(extensions)
  }

  fromYdoc (document: Doc, fieldName?: string | string[] | undefined): any {
    const json = this.transformer.fromYdoc(document, fieldName)
    if (typeof fieldName === 'string') {
      return jsonToMarkup(json)
    }

    if (fieldName === undefined || fieldName.length === 0) {
      fieldName = Array.from(document.share.keys())
    }

    const data: Record<string, string> = {}
    fieldName?.forEach((field) => {
      data[field] = jsonToMarkup(json[field])
    })

    return data
  }

  toYdoc (document: any, fieldName: string): Doc {
    if (typeof document === 'string' && document !== '') {
      const json = markupToJSON(document)
      return this.transformer.toYdoc(json, fieldName)
    }

    return new Doc()
  }
}
