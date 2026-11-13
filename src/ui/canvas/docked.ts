'use client'

import { createContext, useContext } from 'react'

/** True inside the command panel when it is fixed to the right edge at full height (the steps layout), where there is room to lay things out larger. */
export const DockedContext = createContext(false)
export const useDocked = () => useContext(DockedContext)
