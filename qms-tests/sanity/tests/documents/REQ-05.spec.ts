import { test } from '@playwright/test'
import { attachScreenshot, generateId, HomepageURI, PlatformSetting, PlatformURI } from '../utils'
import { allure } from 'allure-playwright'
import { DocumentContentPage } from '../model/documents/document-content-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'

import { faker } from '@faker-js/faker'
import { createTemplateStep } from './common-documents-steps'

test.use({
  storageState: PlatformSetting
})

test.describe('ISO 13485, 4.2.4 Control of documents', () => {
  test.beforeEach(async ({ page }) => {
    await (await page.goto(`${PlatformURI}/${HomepageURI}`))?.finished()
  })

  test.afterEach(async ({ browser }) => {
    const contexts = browser.contexts()
    for (const context of contexts) {
      await context.close()
    }
  })

  test('TESTS-298. Create a new Category from top right corner', async ({ page }) => {
    await allure.description('Requirement\nUsers need to create a new category')
    await allure.tms('TESTS-298', 'https://tracex.hc.engineering/workbench/platform/tracker/TESTS-298')

    const title = faker.word.words(2)
    const description = faker.lorem.sentence(1)
    const code = faker.word.words(2)
    const leftSideMenuPage = new LeftSideMenuPage(page)

    await leftSideMenuPage.clickButtonOnTheLeft('Documents')
    await test.step('2. Create a new category', async () => {
      const documentContentPage = new DocumentContentPage(page)
      await documentContentPage.selectControlDocumentSubcategory('Categories')
      await documentContentPage.clickOnAddCategoryButton()
      await documentContentPage.fillCategoryForm(title, description, code)
      await documentContentPage.checkIfCategoryIsCreated(title, code)
    })

    await attachScreenshot('TESTS-298_category_created.png', page)
  })

  test('TESTS-381. As a workspace user, I can create a new space and label it External Doc', async ({ page }) => {
    await allure.description('Requirement\nUsers need to create a new space')
    await allure.tms('TESTS-381', 'https://tracex.hc.engineering/workbench/platform/tracker/TESTS-381')
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const folderName = generateId(5)

    await leftSideMenuPage.clickButtonOnTheLeft('Documents')
    await test.step('2. Create a new document space', async () => {
      const documentContentPage = new DocumentContentPage(page)
      await documentContentPage.clickAddFolderButton()
      await documentContentPage.fillDocumentSpaceForm(folderName)
      await documentContentPage.checkSpaceFormIsCreated(folderName)
      await documentContentPage.clickLeaveFolder(folderName)
    })

    await attachScreenshot('TESTS-381_document_space_created.png', page)
  })

  test('TESTS-382. Create new a new Effective Template with category External', async ({ page }) => {
    await allure.description('Requirement\nUsers need to create a new template')
    await allure.tms('TESTS-382', 'https://tracex.hc.engineering/workbench/platform/tracker/TESTS-382')
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const category = faker.word.words(2)
    const description = faker.lorem.sentence(1)
    const code = faker.word.words(2)
    const title = faker.word.words(2)

    await leftSideMenuPage.clickButtonOnTheLeft('Documents')
    await test.step('2. Create a new category', async () => {
      const documentContentPage = new DocumentContentPage(page)
      await documentContentPage.selectControlDocumentSubcategory('Categories')
      await documentContentPage.clickOnAddCategoryButton()
      await documentContentPage.fillCategoryForm(category, description, code)
      await documentContentPage.checkIfCategoryIsCreated(category, code)
    })
    await test.step('3. Create a new template', async () => {
      const documentContentPage = new DocumentContentPage(page)

      await documentContentPage.clickNewDocumentArrow()
      await documentContentPage.clickNewTemplate()
      await createTemplateStep(page, title, description, category)
    })

    await attachScreenshot('TESTS-382_Template_created.png', page)
  })

  test('TESTS-383. authorized User can search a doc per category "External"', async ({ page }) => {
    await allure.description('Requirement\nUsers need to create a new category and space')
    await allure.tms('TESTS-383', 'https://tracex.hc.engineering/workbench/platform/tracker/TESTS-383')

    const title = faker.word.words(2)
    const description = faker.lorem.sentence(1)
    const code = faker.word.words(2)
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const category = faker.word.words(2)

    await leftSideMenuPage.clickButtonOnTheLeft('Documents')
    await test.step('2. Create a new category', async () => {
      const documentContentPage = new DocumentContentPage(page)
      await documentContentPage.selectControlDocumentSubcategory('Categories')
      await documentContentPage.clickOnAddCategoryButton()
      await documentContentPage.fillCategoryForm(category, description, code)
      await documentContentPage.checkIfCategoryIsCreated(category, code)
    })
    await test.step('3. Create a new template', async () => {
      const documentContentPage = new DocumentContentPage(page)

      await documentContentPage.clickNewDocumentArrow()
      await documentContentPage.clickNewTemplate()
      await createTemplateStep(page, title, description, category)
    })
    await test.step('4. Check if templates exists in template category', async () => {
      const documentContentPage = new DocumentContentPage(page)
      await documentContentPage.selectControlDocumentSubcategory('Templates')
      await documentContentPage.chooseFilter(code)
      await documentContentPage.checkIfFilterIsApplied(title)
    })
    await attachScreenshot('TESTS-383_Template_created.png', page)
  })
})
