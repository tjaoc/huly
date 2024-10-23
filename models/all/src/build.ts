import { writeFileSync } from 'fs'
import builder from './'
const enabled = (process.env.MODEL_ENABLED ?? '*').split(',').map((it) => it.trim())
const disabled = (process.env.MODEL_DISABLED ?? '').split(',').map((it) => it.trim())

const model = JSON.stringify(builder(enabled, disabled).getTxes())
writeFileSync(process.argv[2], model)
