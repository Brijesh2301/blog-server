import { Router } from 'express'

import { adminRouter } from './admin.routes.js'
import { audioRouter } from './audio.routes.js'
import { authRouter } from './auth.routes.js'
import { engagementRouter } from './engagement.routes.js'
import { manifestRouter } from './manifest.routes.js'
import { mediaRouter } from './media.routes.js'
import { postsRouter } from './posts.routes.js'
import { redirectsRouter } from './redirects.routes.js'
import { taxonomyRouter } from './taxonomy.routes.js'

/**
 * Versioned API surface, mounted at /api/v1.
 *
 * Versioning in the path rather than a header: it is visible in logs, easy to
 * cache per version at the CDN, and a client can be pinned without touching
 * request code.
 */
export const apiRouter: Router = Router()

apiRouter.use('/auth', authRouter)
apiRouter.use('/admin', adminRouter)
apiRouter.use('/posts', postsRouter)
apiRouter.use('/redirects', redirectsRouter)
// Comments, reactions and the newsletter all hang off existing resources.
apiRouter.use('/', engagementRouter)
// Listen feature: public speech payload + admin generation controls.
apiRouter.use('/', audioRouter)
// Slug manifest, consumed by the frontend proxy for existence checks.
apiRouter.use('/', manifestRouter)
// Categories, tags, series and authors share one router.
apiRouter.use('/', taxonomyRouter)
// Image upload + media library. Staff only; the router declares its own
// /admin prefix so the paths read the same as the other admin surfaces.
apiRouter.use('/', mediaRouter)
