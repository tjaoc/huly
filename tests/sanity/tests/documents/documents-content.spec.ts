import { test, type Page, expect } from '@playwright/test'
import {
  generateId,
  getTimeForPlanner,
  generateUser,
  createAccountAndWorkspace,
  createAccount,
  getInviteLink,
  generateTestData,
  getSecondPageByInvite
} from '../utils'
import { NewDocument, NewTeamspace } from '../model/documents/types'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { DocumentsPage } from '../model/documents/documents-page'
import { DocumentContentPage } from '../model/documents/document-content-page'
import { PlanningNavigationMenuPage } from '../model/planning/planning-navigation-menu-page'
import { PlanningPage } from '../model/planning/planning-page'
import { SignUpData } from '../model/common-types'
import { TestData } from '../chat/types'

const retryOptions = { intervals: [1000, 1500, 2500], timeout: 60000 }

test.describe('Content in the Documents tests', () => {
  let testData: TestData
  let newUser2: SignUpData
  let testTeamspace: NewTeamspace
  let testDocument: NewDocument

  let leftSideMenuPage: LeftSideMenuPage
  let documentsPage: DocumentsPage
  let documentContentPage: DocumentContentPage

  let secondPage: Page
  let leftSideMenuSecondPage: LeftSideMenuPage
  let documentsSecondPage: DocumentsPage
  let documentContentSecondPage: DocumentContentPage

  test.beforeEach(async ({ browser, page, request }) => {
    leftSideMenuPage = new LeftSideMenuPage(page)
    documentsPage = new DocumentsPage(page)
    documentContentPage = new DocumentContentPage(page)
    testTeamspace = {
      title: `Teamspace-${generateId()}`,
      description: 'Teamspace description',
      autoJoin: true
    }
    testDocument = {
      title: `Document-${generateId()}`,
      space: testTeamspace.title
    }

    testData = generateTestData()
    newUser2 = generateUser()
    await createAccountAndWorkspace(page, request, testData)
    await createAccount(request, newUser2)

    const linkText = await getInviteLink(page)
    await leftSideMenuPage.clickDocuments()
    await documentsPage.checkTeamspaceNotExist(testTeamspace.title)
    await documentsPage.createNewTeamspace(testTeamspace)
    secondPage = await getSecondPageByInvite(browser, linkText, newUser2)

    leftSideMenuSecondPage = new LeftSideMenuPage(secondPage)
    documentsSecondPage = new DocumentsPage(secondPage)
    documentContentSecondPage = new DocumentContentPage(secondPage)
    await documentsPage.clickOnButtonCreateDocument()
    await documentsPage.createDocument(testDocument)
    await documentsPage.openDocument(testDocument.title)
    await documentContentPage.checkDocumentTitle(testDocument.title)
  })

  test('ToDos in the Document', async () => {
    const contents: string[] = ['work', 'meet up']
    let content: string = ''

    for (let i = 0; i < contents.length; i++) {
      content = await documentContentPage.addContentToTheNewLine(`${i === 0 ? '[] ' : ''}${contents[i]}`)
      await documentContentPage.checkContent(content)
    }
    for (const line of contents) {
      await documentContentPage.assignToDo(`${newUser2.lastName} ${newUser2.firstName}`, line)
    }

    await leftSideMenuSecondPage.clickDocuments()
    await documentsSecondPage.openTeamspace(testDocument.space)
    await documentsSecondPage.openDocument(testDocument.title)
    await documentContentSecondPage.checkDocumentTitle(testDocument.title)
    await documentContentSecondPage.checkContent(content)
    await leftSideMenuSecondPage.clickPlanner()

    const planningNavigationMenuPage = new PlanningNavigationMenuPage(secondPage)
    await planningNavigationMenuPage.clickOnButtonToDoAll()
    const planningPage = new PlanningPage(secondPage)
    const time: string = getTimeForPlanner()
    await planningPage.dragToCalendar(contents[0], 1, time)
    await planningPage.dragToCalendar(contents[1], 1, time, true)
    await planningPage.checkInSchedule(contents[0])
    await planningPage.checkInSchedule(contents[1])
    await planningPage.markDoneInToDos(contents[0])
    await planningPage.markDoneInToDos(contents[1])
    await secondPage.close()

    for (const line of contents) await documentContentPage.checkToDo(line, true)
  })

  test('Table in the Document', async ({ page }) => {
    await documentContentPage.inputContentParapraph().click()
    await documentContentPage.leftMenu().click()
    await documentContentPage.menuPopupItemButton('Table').click()
    await documentContentPage.menuPopupItemButton('1x2').first().click()
    await documentContentPage.proseTableCell(0, 0).fill('One')
    await documentContentPage.proseTableCell(0, 1).fill('Two')
    await documentContentPage.buttonInsertColumn().click()
    await documentContentPage.proseTableCell(0, 1).fill('Three')

    await documentContentPage.proseTableColumnHandle(1).hover()
    await expect(async () => {
      await page.mouse.down()
      const boundingBox = await documentContentPage.proseTableCell(0, 1).boundingBox()
      expect(boundingBox).toBeTruthy()
      if (boundingBox != null) {
        await page.mouse.move(boundingBox.x + boundingBox.width * 2, boundingBox.y - 5)
        await page.mouse.move(boundingBox.x + boundingBox.width * 2 + 5, boundingBox.y - 5)
        await page.mouse.up()
      }
    }).toPass(retryOptions)

    await documentContentPage.buttonInsertLastRow().click()
    await documentContentPage.proseTableCell(1, 1).fill('Bottom')
    await documentContentPage.buttonInsertInnerRow().click()
    await documentContentPage.proseTableCell(1, 1).fill('Middle')

    await leftSideMenuSecondPage.clickDocuments()
    await documentsSecondPage.openTeamspace(testDocument.space)
    await documentsSecondPage.openDocument(testDocument.title)
    await documentContentSecondPage.checkDocumentTitle(testDocument.title)
    await expect(documentContentSecondPage.proseTableCell(1, 1)).toContainText('Middle')
    await documentContentSecondPage.proseTableCell(1, 1).dblclick()
    await documentContentSecondPage.proseTableCell(1, 1).fill('Center')
    await expect(documentContentPage.proseTableCell(1, 1)).toContainText('Center', { timeout: 5000 })
    await secondPage.close()
  })
})
