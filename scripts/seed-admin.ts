import bcrypt from 'bcryptjs'

import { db } from '../src/db/index.js'
import { users } from '../src/db/schema.js'

const email = process.env.SEED_EMAIL!
const password = process.env.SEED_PASSWORD!

const passwordHash = await bcrypt.hash(password, 12)

await db
  .insert(users)
  .values({
    email: email.toLowerCase(),
    passwordHash,
    name: 'Brijesh',
    slug: 'brijesh',
    role: 'admin',
    emailVerifiedAt: new Date(),
    isActive: true,
  })
  .onConflictDoUpdate({
    target: users.email,
    set: { passwordHash, role: 'admin', isActive: true, updatedAt: new Date() },
  })

console.log('Admin user ready:', email)
process.exit(0)
