//
// Copyright © 2023, 2024 Hardcore Engineering Inc.
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

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { TableMap } from '@tiptap/pm/tables'
import type { TableNodeLocation } from '../types'

type TableRow = Array<ProseMirrorNode | null>
type TableRows = TableRow[]

export function moveColumn (table: TableNodeLocation, from: number, to: number, tr: Transaction): Transaction {
  const cols = transpose(tableToCells(table))
  moveRowInplace(cols, from, to)
  tableFromCells(table, transpose(cols), tr)
  return tr
}

export function moveRow (table: TableNodeLocation, from: number, to: number, tr: Transaction): Transaction {
  const rows = tableToCells(table)
  moveRowInplace(rows, from, to)
  tableFromCells(table, rows, tr)
  return tr
}

function isNotNull<T> (value: T | null): value is T {
  return value !== null
}

export function duplicateRows (table: TableNodeLocation, rowIndices: number[], tr: Transaction): Transaction {
  const rows = tableToCells(table)

  const { map, width } = TableMap.get(table.node)
  const mapStart = tr.mapping.maps.length

  const lastRowPos = map[rowIndices[rowIndices.length - 1] * width + width - 1]
  const nextRowStart = lastRowPos + (table.node.nodeAt(lastRowPos)?.nodeSize ?? 0) + 1
  const insertPos = tr.mapping.slice(mapStart).map(table.start + nextRowStart)

  for (let i = rowIndices.length - 1; i >= 0; i--) {
    tr.insert(insertPos, rows[rowIndices[i]].filter(isNotNull))
  }

  return tr
}

export function duplicateColumns (table: TableNodeLocation, columnIndices: number[], tr: Transaction): Transaction {
  const rows = tableToCells(table)

  const { map, width, height } = TableMap.get(table.node)
  const mapStart = tr.mapping.maps.length

  for (let row = 0; row < height; row++) {
    const lastColumnPos = map[row * width + columnIndices[columnIndices.length - 1]]
    const nextColumnStart = lastColumnPos + (table.node.nodeAt(lastColumnPos)?.nodeSize ?? 0)
    const insertPos = tr.mapping.slice(mapStart).map(table.start + nextColumnStart)

    for (let i = columnIndices.length - 1; i >= 0; i--) {
      const copiedNode = rows[row][columnIndices[i]]
      if (copiedNode !== null) {
        tr.insert(insertPos, copiedNode)
      }
    }
  }

  return tr
}

function moveRowInplace (rows: TableRows, from: number, to: number): void {
  rows.splice(to, 0, rows.splice(from, 1)[0])
}

function transpose (rows: TableRows): TableRows {
  return rows[0].map((_, colIdx) => rows.map((row) => row[colIdx]))
}

function tableToCells (table: TableNodeLocation): TableRows {
  const { map, width, height } = TableMap.get(table.node)

  const rows = []
  for (let row = 0; row < height; row++) {
    const cells = []
    for (let col = 0; col < width; col++) {
      const pos = map[row * width + col]
      cells.push(table.node.nodeAt(pos))
    }
    rows.push(cells)
  }

  return rows
}

function tableFromCells (table: TableNodeLocation, rows: TableRows, tr: Transaction): void {
  const { map, width, height } = TableMap.get(table.node)
  const mapStart = tr.mapping.maps.length

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pos = map[row * width + col]

      const oldCell = table.node.nodeAt(pos)
      const newCell = rows[row][col]

      if (oldCell !== null && newCell !== null && oldCell !== newCell) {
        const start = tr.mapping.slice(mapStart).map(table.start + pos)
        const end = start + oldCell.nodeSize

        tr.replaceWith(start, end, newCell)
      }
    }
  }
}
