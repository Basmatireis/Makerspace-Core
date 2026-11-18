/*
 * The editor imports its icons from their own modules of @carbon/icons-react, not from the package index. Through the
 * index, the bundler compiles every icon the editor uses into the icon bucket chunks that the application entry already
 * loads: the editor grew the initial JavaScript by about 2 kB gzip that way (measured 224,994 B of the 225,000 B budget
 * against 222,775 B without the editor). The per-icon modules stay in this lazy route chunk.
 */
export { default as Add } from '@carbon/icons-react/es/Add.js';
export { default as ArrowDown } from '@carbon/icons-react/es/ArrowDown.js';
export { default as ArrowUp } from '@carbon/icons-react/es/ArrowUp.js';
export { default as Barcode } from '@carbon/icons-react/es/Barcode.js';
export { default as Box } from '@carbon/icons-react/es/Box.js';
export { default as Calendar } from '@carbon/icons-react/es/Calendar.js';
export { default as Checkbox } from '@carbon/icons-react/es/Checkbox.js';
export { default as Checkmark } from '@carbon/icons-react/es/Checkmark.js';
export { default as ChevronDown } from '@carbon/icons-react/es/ChevronDown.js';
export { default as ChevronUp } from '@carbon/icons-react/es/ChevronUp.js';
export { default as CircleStroke } from '@carbon/icons-react/es/CircleStroke.js';
export { default as Column } from '@carbon/icons-react/es/Column.js';
export { default as ConditionPoint } from '@carbon/icons-react/es/ConditionPoint.js';
export { default as Copy } from '@carbon/icons-react/es/Copy.js';
export { default as Cursor_1 } from '@carbon/icons-react/es/Cursor_1.js';
export { default as DecisionTree } from '@carbon/icons-react/es/DecisionTree.js';
export { default as DistributeVerticalCenter } from '@carbon/icons-react/es/DistributeVerticalCenter.js';
export { default as Document } from '@carbon/icons-react/es/Document.js';
export { default as Draggable } from '@carbon/icons-react/es/Draggable.js';
export { default as Image } from '@carbon/icons-react/es/Image.js';
export { default as Layers } from '@carbon/icons-react/es/Layers.js';
export { default as LineThin } from '@carbon/icons-react/es/LineThin.js';
export { default as Link } from '@carbon/icons-react/es/Link.js';
export { default as ListBulleted } from '@carbon/icons-react/es/ListBulleted.js';
export { default as Locked } from '@carbon/icons-react/es/Locked.js';
export { default as Loop } from '@carbon/icons-react/es/Loop.js';
export { default as PageBreak } from '@carbon/icons-react/es/PageBreak.js';
export { default as PageNumber } from '@carbon/icons-react/es/PageNumber.js';
export { default as Pen } from '@carbon/icons-react/es/Pen.js';
export { default as QrCode } from '@carbon/icons-react/es/QrCode.js';
export { default as Redo } from '@carbon/icons-react/es/Redo.js';
export { default as Shapes } from '@carbon/icons-react/es/Shapes.js';
export { default as SquareOutline } from '@carbon/icons-react/es/SquareOutline.js';
export { default as Subtract } from '@carbon/icons-react/es/Subtract.js';
export { default as Table } from '@carbon/icons-react/es/Table.js';
export { default as TableOfContents } from '@carbon/icons-react/es/TableOfContents.js';
export { default as TableSplit } from '@carbon/icons-react/es/TableSplit.js';
export { default as TextFont } from '@carbon/icons-react/es/TextFont.js';
export { default as TextLeading } from '@carbon/icons-react/es/TextLeading.js';
export { default as TextLongParagraph } from '@carbon/icons-react/es/TextLongParagraph.js';
export { default as TextScale } from '@carbon/icons-react/es/TextScale.js';
export { default as TextUnderline } from '@carbon/icons-react/es/TextUnderline.js';
export { default as TrashCan } from '@carbon/icons-react/es/TrashCan.js';
export { default as Undo } from '@carbon/icons-react/es/Undo.js';
export { default as Unlink } from '@carbon/icons-react/es/Unlink.js';
export { default as Version } from '@carbon/icons-react/es/Version.js';
export { default as ZoomIn } from '@carbon/icons-react/es/ZoomIn.js';
export { default as ZoomOut } from '@carbon/icons-react/es/ZoomOut.js';
